# Campground Bot

**No download? Use the website version:** [![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/bb520xx-code/campground-bot) (details [below](#website-version-no-download))

Watches a [recreation.gov](https://www.recreation.gov) campground and alerts you (notification, sound, and the booking page opening) when a site opens up for your dates.

- Search by campground name or paste a recreation.gov link
- Pick dates, flexible or exact, and number of nights in a row
- Filter by electric hookup, RV, drive-up, group sites and group size
- Live availability grid; watch any site or only the sites you tick
- Choose how often to check: every 30 seconds up to every 30 minutes (default 2 minutes)
- More options: site type, loop, ADA-accessible, pets, campfires, equipment (tent/RV/trailer...), rig length, driveway type, number of vehicles
- Phone alerts through [ntfy](https://ntfy.sh): install the free ntfy app, subscribe to the private topic shown in the app, and turn alerts on

## Run

Requires [Node.js](https://nodejs.org) 18 or newer. No dependencies to install.

```
npm start
```

Then open http://localhost:3000. Or run `npm install && npm run app` for the desktop window, and `npm run build` to make a Mac app. Keep the tab open while watching; allow notifications when asked.

## Notes

- recreation.gov doesn't allow calls straight from a web page, so `server.js` runs locally and relays requests to it. That's why this can't be hosted on GitHub Pages alone.
- Uses recreation.gov's unofficial website API, which may change. The bot only reads availability; you book on recreation.gov yourself.

## Website version (no download)

The app can also run as a website that anyone opens in a browser. It needs a small always-on server (recreation.gov blocks pages from calling it directly), so it can't live on GitHub Pages. This repo includes a ready config for [Render](https://render.com)'s free plan:

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/bb520xx-code/campground-bot)

1. Click the button and sign in to Render (connect GitHub when asked).
2. Accept the defaults and click **Apply**. A minute later you get a link like `https://campground-bot-xxxx.onrender.com`.
3. Share that link.

How the website version differs from the Mac app:

- **Watching only happens while the page is open in a browser tab.** Close the tab and checks stop (the Mac app keeps checking in the background). Phone alerts, if enabled, still arrive on your phone while the tab is open.
- Each visitor's watches and phone topic are saved only in their own browser. Nothing is shared between visitors.
- Phone alerts go straight from the visitor's browser to ntfy.sh, never through the server.
- All visitors share one server, so heavy use can make recreation.gov rate-limit it. The server limits each visitor to 240 requests a minute (`RATE_LIMIT` to change).
- Render's free plan sleeps after 15 minutes without visits, so the first load can take about 30 seconds.
- Hosting from a data-center address is not guaranteed to be accepted by recreation.gov. If searches fail on the hosted site but work on your computer, that's why.
