// Vercel serverless entry point.
// Vercel's @vercel/node runtime detects the default-exported Express app
// and wraps it as a serverless function automatically.
import app from "../src/app.js";

export default app;
