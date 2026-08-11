// Local development entry point (not used by Vercel).
// Run with: pnpm dev
import app from "./app.js";

const port = Number(process.env.PORT ?? 3000);

app.listen(port, () => {
  console.log(`[Engine] Server listening on http://localhost:${port}`);
});
