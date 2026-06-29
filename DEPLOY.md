# Deploying to Render

This app is a Node + Socket.IO server, so it needs a host that runs a real Node
process (Render does; Netlify does not). The included `render.yaml` makes it almost
one-click.

## Option A — Deploy from GitHub (recommended, auto-updates)

1. **Put the project on GitHub.**
   In the project folder (`first-goalscorer`):
   ```bash
   git init
   git add .
   git commit -m "First Goalscorer game"
   git branch -M main
   git remote add origin https://github.com/<your-username>/first-goalscorer.git
   git push -u origin main
   ```
   (Create the empty repo first at https://github.com/new — don't add a README there.)

2. **Create the service on Render.**
   - Go to https://dashboard.render.com → **New +** → **Blueprint**.
   - Connect your GitHub and pick the `first-goalscorer` repo.
   - Render reads `render.yaml` and fills everything in (build `npm install`,
     start `npm start`, free plan). Click **Apply**.

3. Wait for the build. You'll get a URL like `https://first-goalscorer.onrender.com`.
   Share that link / the 4-letter game code with players. Done.

   Any future `git push` auto-redeploys.

## Option B — No GitHub (manual web service)

1. Render dashboard → **New +** → **Web Service** → **Deploy without a Git repo** /
   "Public Git repository", or use Render's CLI.
2. Set: **Runtime** Node, **Build command** `npm install`, **Start command** `npm start`,
   **Plan** Free. Deploy.

## Important: free-tier "cold start"

Render's **free** web services **spin down after ~15 minutes of inactivity**, and the
next visit takes ~30–60s to wake up. For a live match that matters:

- **Open the URL ~2 minutes before you share it** so it's already awake when players join.
- Or upgrade to Render's cheapest paid instance (always-on) for match day.

Once it's awake, in-memory game state lives only while the server is up — perfect for a
single match, but a spin-down/redeploy clears all rooms. Just create a fresh game if that
happens.

## Custom port

The server already respects Render's `PORT` env var automatically — no config needed.
Locally you can override with `PORT=8080 npm start`.
