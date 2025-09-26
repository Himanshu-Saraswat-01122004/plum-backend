const express = require('express');
const multer = require('multer');
const sharp = require('sharp');
const Tesseract = require('tesseract.js');
const fs = require('fs').promises; // Using promises for async file operations
const crypto = require('crypto');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const router = express.Router();

// Initialize the Google Generative AI client
const genAI = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY);

// Setup multer for file storage on disk
// We'll use memoryStorage to get the buffer for hashing, then save manually
const storage = multer.memoryStorage();
const upload = multer({ storage: storage });

/**
 * @swagger
 * /extract-amounts:
 *   post:
 *     summary: Uploads a bill image to extract monetary amounts.
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             properties:
 *               billImage:
 *                 type: string
 *                 format: binary
 *     responses:
 *       200:
 *         description: Successfully extracted financial amounts from the image.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 currency:
 *                   type: string
 *                   example: INR
 *                 amounts:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       type:
 *                         type: string
 *                         enum: [total_bill, paid, due]
 *                       value:
 *                         type: number
 *                       source:
 *                         type: string
 *                 status:
 *                   type: string
 *                   example: ok
 *       400:
 *         description: No file uploaded.
 *       500:
 *         description: Failed to process image or parse AI response.
 */
router.post('/extract-amounts', upload.single('billImage'), async (req, res) => {
  if (!req.file) {
    return res.status(400).send('No file uploaded.');
  }

  try {
    const hash = crypto.createHash('sha256').update(req.file.buffer).digest('hex');
    const imagePath = `uploads/${hash}.png`;
    const jsonPath = `uploads/${hash}.json`;

    // Check for a cached JSON result
    try {
      const cachedJson = await fs.readFile(jsonPath, 'utf-8');
      console.log('Returning cached JSON result.');
      return res.status(200).json(JSON.parse(cachedJson));
    } catch (error) {
      // If no cache, process the image
      console.log('Processing new image.');

      const processedImageBuffer = await sharp(req.file.buffer).grayscale().threshold(128).toBuffer();

      const worker = await Tesseract.createWorker('eng');
      const { data: { text: ocrText } } = await worker.recognize(processedImageBuffer);
      await worker.terminate();

      // --- LLM Data Extraction ---
      // Prefer Flash; fall back to Pro and latest aliases if needed
      const envModel = process.env.GEMINI_MODEL; // allow overriding via .env
      const defaults = [
        'gemini-1.5-flash-8b',
        'gemini-1.5-flash-8b-latest',
        'gemini-1.5-pro',
        'gemini-1.5-pro-latest'
      ];
      const modelCandidates = envModel ? [envModel, ...defaults] : defaults;

      let model;
      let lastInitError;
      for (const name of modelCandidates) {
        try {
          model = genAI.getGenerativeModel({ model: name });
          break;
        } catch (e) {
          lastInitError = e;
        }
      }
      if (!model) {
        console.error('Failed to initialize any Gemini model', lastInitError);
        return res.status(502).json({ error: 'LLM initialization failed. Please verify model access in Google AI Studio and try again.' });
      }
      console.log('Using Gemini model:', model?.model || modelCandidates.find(Boolean));
      
      const prompt = `You are an expert financial data extraction AI specializing in medical documents.
Your task is to extract financial amounts from the following text, which may contain OCR errors.

Instructions:
1. Correct any obvious OCR errors in numbers (e.g., 'l' should be '1', 'O' should be '0').
2. Identify the currency (look for symbols like $, ₹, INR, USD, EUR, etc.). Default to "INR" if unclear.
3. Extract amounts for: "total_bill", "paid", "due". Look for keywords like Total, Subtotal, Amount Due, Paid, Balance, etc.
4. For each amount found, include the exact source text from the document.
5. If you cannot find a value for a specific type, do not include it in the amounts array.
6. Your response MUST be a single, valid JSON object in this exact format:

{
  "currency": "[detected currency code]",
  "amounts": [
    {"type":"total_bill","value":[number],"source":"text: '[exact text from document]'"},
    {"type":"paid","value":[number],"source":"text: '[exact text from document]'"},
    {"type":"due","value":[number],"source":"text: '[exact text from document]'"}
  ],
  "status":"ok"
}

Do not include markdown formatting, explanations, or any text outside the JSON.

Text to analyze:
---
${ocrText}
---

JSON Output:`;

      let llmResponse;
      let selectedModelName = model?.model || modelCandidates[0];
      // Attempt generateContent with fallbacks when 404 occurs
      for (const name of modelCandidates) {
        try {
          const m = genAI.getGenerativeModel({ model: name });
          const result = await m.generateContent(prompt);
          llmResponse = await result.response.text();
          selectedModelName = name;
          console.log('Gemini generateContent succeeded with model:', name);
          break;
        } catch (llmErr) {
          const status = llmErr?.status || 502;
          const statusText = llmErr?.statusText || 'LLM error';
          console.warn('LLM call failed for model', name, status, statusText);
          // If it's a 404, try the next candidate
          if (status === 404) {
            continue;
          }
          // For 429 or other errors, return immediately
          return res.status(status === 429 ? 429 : 502).json({
            error: 'LLM call failed',
            status,
            statusText,
            hint: status === 429 ? 'Rate limit exceeded. Please retry after some time.' : 'Check API key and model name or permissions in AI Studio.',
          });
        }
      }
      if (!llmResponse) {
        return res.status(404).json({
          error: 'No accessible Gemini model found for your API key/region. Set GEMINI_MODEL in .env to a model you can access (e.g., gemini-1.5-pro, gemini-1.5-flash-8b) and restart.',
        });
      }

      // Clean the response to remove markdown formatting
      const cleanedResponse = llmResponse.replace(/```json/g, '').replace(/```/g, '').trim();

      let extractedData;
      try {
        extractedData = JSON.parse(cleanedResponse);
      } catch (parseError) {
        console.error('Failed to parse LLM response as JSON:', llmResponse);
        return res.status(500).send('Error: The AI returned an invalid format.');
      }

      // Save the original image and the final JSON data for caching
      await fs.writeFile(imagePath, req.file.buffer);
      await fs.writeFile(jsonPath, JSON.stringify(extractedData, null, 2));

      res.status(200).json(extractedData);
    }
  } catch (error) {
    console.error('Error processing image:', error);
    res.status(500).send('Failed to process image.');
  }
});

module.exports = router;
