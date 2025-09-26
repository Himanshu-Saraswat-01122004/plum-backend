const express = require('express');
const swaggerUi = require('swagger-ui-express');
require('dotenv').config();

const swaggerDocs = require('./swagger');
const extractRoutes = require('./routes/extract');

const app = express();
const port = process.env.PORT || 3000;

// Swagger UI
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerDocs));

// Routes
app.use('/', extractRoutes);

/**
 * @swagger
 * /health:
 *   get:
 *     summary: Checks if the server is running.
 *     responses:
 *       200:
 *         description: Server is up and running.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status:
 *                   type: string
 *                   example: UP and RUNNING
 */
app.get('/health', (req, res) => {
    res.status(200).json({ status: 'UP and RUNNING' });
  });
  

app.listen(port, () => {
  console.log(`Server is running on http://localhost:${port}`);
});
