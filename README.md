# Campground Bot

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
