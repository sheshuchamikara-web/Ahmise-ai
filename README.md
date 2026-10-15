# Ahmise (real AI version)

This version has its own server. It uses the Claude API, so Ahmise can search the web, read links, check the time and do exact maths. It does not use your Claude plan limit, and the mic works in Chrome.

## What you need
1. An Anthropic API account and key: https://console.anthropic.com (add a little credit; you pay per use).
2. A free GitHub account and a Render account: https://render.com

## Put it online (about 10 minutes)
1. On GitHub, make a new private repository and upload everything in this folder (not node_modules or .env).
2. On Render: New > Web Service > connect that repository.
3. Settings: Runtime Node, Build command `npm install`, Start command `npm start`.
4. Under Environment, add:
   - `ANTHROPIC_API_KEY` = your key
   - `APP_PASSWORD` = a long secret code you choose
   - `OPENAI_API_KEY` = (optional) for real images, from https://platform.openai.com
   - `GEMINI_API_KEY` = (optional) for real videos, from https://aistudio.google.com
5. Deploy. Open the link Render gives you, type your code once, and chat.

## Run on a computer instead
```
npm install
cp .env.example .env    # then fill in the two values
export $(cat .env | xargs) && npm start
```
Open http://localhost:3000

## Real images and videos
- Images use OpenAI's image model. Videos use Google's Veo model. Each needs its own key and its own paid credit; both can be left blank.
- In Create an image there is now an Image / Video switch. Videos take a few minutes.
- Images and videos are not kept after you close the page. Tap Save right after they are made.
- Model names change over time. If one stops working, set `IMAGE_MODEL` or `VIDEO_MODEL` in Environment.
- OpenAI's old Sora video service was shut down, which is why video uses Google Veo.

## Notes
- Anyone who has the link and your code spends your credit. Keep the code private.
- Tools: web search, read a link, date and time, calculator. Gmail, Drive and GitHub connectors are not included yet.
- Chats are saved in each browser (no cloud sync in this version).
