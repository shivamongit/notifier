# 🎬 Dhurandhar 2 Movie Notifier

Monitors **BookMyShow** & **District.in** for "Dhurandhar 2: The Revenge" showtimes at **SLN Platinum Cinemas** and **Aparna Cinemas** in Hyderabad on **March 19 & 21, 2026**.

Sends instant push notifications to your phone via **ntfy.sh** (100% free).

## Quick Setup (3 Steps)

### Step 1: Install ntfy app on your phone
1. **Android**: Install [ntfy from Google Play](https://play.google.com/store/apps/details?id=io.heckel.ntfy)
2. **iPhone**: Install [ntfy from App Store](https://apps.apple.com/app/ntfy/id1625396347)
3. Open the app → tap **"+"** → Subscribe to topic: `dhurandhar2-hyd-shivam`
4. Allow notifications when prompted

> **Important**: You can change the topic name in `index.js` (line with `NTFY_TOPIC`) to something secret so only you get the notifications.

### Step 2: Test locally
```bash
cd dhurandhar2-notifier
npm install
npm start
```
You should receive a startup notification on your phone within seconds!

### Step 3: Deploy to Render.com (FREE - runs 24/7)
1. Create a free account at [render.com](https://render.com)
2. Push this code to a GitHub repo:
   ```bash
   cd dhurandhar2-notifier
   git init
   git add .
   git commit -m "Dhurandhar 2 notifier"
   ```
3. Go to [GitHub](https://github.com) → Create a new repo → push to it:
   ```bash
   git remote add origin https://github.com/YOUR_USERNAME/dhurandhar2-notifier.git
   git push -u origin main
   ```
4. On Render.com dashboard → **New** → **Web Service** → Connect your GitHub repo
5. Settings:
   - **Build Command**: `npm install`
   - **Start Command**: `node index.js`
   - **Plan**: Free
6. Click **Deploy**

That's it! The notifier runs 24/7 checking every 5 minutes.

## How it works

- Checks **BookMyShow** (API + web scrape) and **District.in** every 5 minutes
- Searches for SLN Platinum & Aparna Cinemas in the results
- Sends push notification instantly via ntfy.sh when shows are found
- Avoids duplicate notifications (won't spam you)
- Auto-stops after March 22, 2026

## Cost: ₹0 (FREE)

| Service | Cost |
|---------|------|
| ntfy.sh | Free |
| Render.com (Free tier) | Free |
| **Total** | **₹0** |

## Customizing

Edit the `CONFIG` object in `index.js` to change:
- `NTFY_TOPIC` — your unique notification channel name
- `TARGET_CINEMAS` — add/remove cinema names
- `TARGET_DATES` — add/remove dates
- `CRON_SCHEDULE` — change check frequency (default: every 5 min)

## Troubleshooting

- **No notifications?** Make sure you subscribed to the exact topic name in the ntfy app
- **Want to test?** Run `curl -d "Test notification" ntfy.sh/dhurandhar2-hyd-shivam` from terminal
- **Check status**: Visit your Render.com URL → shows running status and notification count
