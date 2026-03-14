const cron = require("node-cron");
const axios = require("axios");
const cheerio = require("cheerio");

// ============== CONFIGURATION ==============
const CONFIG = {
  // ntfy.sh topic - CHANGE THIS to your own unique secret topic name
  NTFY_TOPIC: process.env.NTFY_TOPIC || "dhurandhar2-hyd-shivam",

  // Movie details
  MOVIE_NAME: "dhurandhar",
  MOVIE_KEYWORDS: ["dhurandhar", "dhurandhar 2", "dhurandhar part 2", "dhurandhar the revenge", "dhurandhar: the revenge"],

  // Target cinemas (lowercase for matching)
  TARGET_CINEMAS: ["sln platinum", "aparna"],

  // Target dates
  TARGET_DATES: ["2026-03-19", "2026-03-21"],
  TARGET_DATE_LABELS: ["19 mar", "21 mar", "march 19", "march 21", "19/03", "21/03", "wed 19", "fri 21"],

  // BookMyShow event IDs for Dhurandhar 2: The Revenge
  BMS_EVENT_IDS: ["ET00478890", "ET00478891"],
  BMS_CITY_CODE: "HYDR",
  BMS_REGION: "hyderabad",

  // District.in movie ID
  DISTRICT_MOVIE_ID: "MV201380",
  DISTRICT_SLUG: "dhurandhar-movie-tickets-in-hyderabad-MV201380",

  // Check interval: every 5 minutes
  CRON_SCHEDULE: "*/5 * * * *",

  // Track already-sent notifications to avoid spam
  sentNotifications: new Set(),

  // Rotating user agents
  USER_AGENTS: [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Mobile Safari/537.36",
  ],
};

function randomUA() {
  return CONFIG.USER_AGENTS[Math.floor(Math.random() * CONFIG.USER_AGENTS.length)];
}

// ============== NOTIFICATION via ntfy.sh ==============
async function sendNotification(title, message, priority = "high", tags = "movie_camera,ticket") {
  // Use a simplified key to dedupe (strip emojis/special chars for key)
  const notifKey = `${title.replace(/[^a-zA-Z0-9 ]/g, '')}::${message.replace(/[^a-zA-Z0-9 ]/g, '')}`;
  if (CONFIG.sentNotifications.has(notifKey)) {
    console.log(`[SKIP] Already sent: ${title}`);
    return;
  }

  // ntfy headers must be ASCII-safe, so strip emojis from title
  const safeTitle = title.replace(/[^\x20-\x7E]/g, "").trim();

  try {
    await axios.post(`https://ntfy.sh/${CONFIG.NTFY_TOPIC}`, message, {
      headers: {
        Title: safeTitle || "Dhurandhar 2 Alert",
        Priority: priority,
        Tags: tags,
      },
    });
    CONFIG.sentNotifications.add(notifKey);
    console.log(`[NOTIFIED] ${safeTitle}: ${message}`);
  } catch (err) {
    console.error(`[ERROR] Failed to send notification:`, err.message);
  }
}

// ============== BookMyShow CHECKER ==============
async function checkBookMyShow() {
  console.log(`[BMS] Checking BookMyShow...`);

  // Approach 1: BMS showtimes API (multiple known endpoint formats)
  const apiUrls = [];
  for (const eventId of CONFIG.BMS_EVENT_IDS) {
    for (const date of CONFIG.TARGET_DATES) {
      apiUrls.push({
        url: `https://in.bookmyshow.com/serv/getData?cmd=GETSHOWTIMESBYEVENTANDVENUE&f=json&dc=${date}&ec=${eventId}&ession&rc=${CONFIG.BMS_CITY_CODE}&pa=true`,
        eventId,
        date,
        label: "BMS-API-v1",
      });
      apiUrls.push({
        url: `https://in.bookmyshow.com/serv/getData?cmd=GETSHOWSBYDATE&f=json&dc=${date}&ec=${eventId}&rc=${CONFIG.BMS_CITY_CODE}`,
        eventId,
        date,
        label: "BMS-API-v2",
      });
    }
  }

  for (const { url, eventId, date, label } of apiUrls) {
    try {
      const resp = await axios.get(url, {
        headers: {
          "User-Agent": randomUA(),
          Accept: "application/json, text/plain, */*",
          Referer: `https://in.bookmyshow.com/buytickets/${eventId}`,
          Origin: "https://in.bookmyshow.com",
        },
        timeout: 15000,
      });

      const data = resp.data;
      if (data) {
        // BMS API can return data in various shapes
        if (data.ShowDetails) processBookMyShowData(data.ShowDetails, date);
        else if (data.cinemas) processBookMyShowCinemas(data.cinemas, date);
        else if (data.BookMyShow?.arrShows) processBookMyShowData(data.BookMyShow.arrShows, date);
        else {
          const jsonStr = JSON.stringify(data).toLowerCase();
          if (jsonStr.length > 100) {
            checkRawDataForCinemas(jsonStr, date, label);
          }
        }
        console.log(`[BMS] ${label} ${eventId} ${date}: Got ${JSON.stringify(data).length} bytes`);
      }
    } catch (err) {
      // 403/404 are expected until showtimes are published
      if (err.response?.status !== 403 && err.response?.status !== 404) {
        console.log(`[BMS] ${label} ${eventId} ${date}: ${err.message}`);
      }
    }
  }

  // Approach 2: Scrape the movie info page (lighter, less likely to be blocked)
  for (const eventId of CONFIG.BMS_EVENT_IDS) {
    try {
      const url = `https://in.bookmyshow.com/hyderabad/movies/dhurandhar-part-2-the-revenge/${eventId}`;
      const resp = await axios.get(url, {
        headers: {
          "User-Agent": randomUA(),
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.9",
          "Cache-Control": "no-cache",
        },
        timeout: 15000,
        maxRedirects: 5,
      });

      const html = resp.data.toLowerCase();
      checkRawDataForCinemas(html, "any", "BookMyShow-Web");
      console.log(`[BMS] Movie page for ${eventId}: Got ${html.length} chars`);
    } catch (err) {
      if (err.response?.status !== 403) {
        console.log(`[BMS] Movie page ${eventId}: ${err.message}`);
      }
    }
  }
}

function processBookMyShowData(showDetails, date) {
  for (const venue of showDetails) {
    const venueNameLower = (venue.VenueName || venue.CinemaName || "").toLowerCase();
    for (const target of CONFIG.TARGET_CINEMAS) {
      if (venueNameLower.includes(target)) {
        const shows = venue.ShowTimes || venue.Shows || [];
        const showInfo = shows.map((s) => s.ShowTime || s.Time || "").join(", ") || "Check app for times";
        sendNotification(
          `🎬 Dhurandhar 2 FOUND on ${date}!`,
          `${venue.VenueName || venue.CinemaName} has shows on ${date}!\nTimes: ${showInfo}\nBook NOW on BookMyShow!`,
          "urgent",
          "rotating_light,movie_camera"
        );
      }
    }
  }
}

function processBookMyShowCinemas(cinemas, date) {
  for (const cinema of cinemas) {
    const cinemaName = (cinema.name || cinema.cinemaName || cinema.CinemaName || "").toLowerCase();
    for (const target of CONFIG.TARGET_CINEMAS) {
      if (cinemaName.includes(target)) {
        sendNotification(
          `🎬 Dhurandhar 2 FOUND on ${date}!`,
          `${cinema.name || cinema.cinemaName || cinema.CinemaName} has shows on ${date}!\nBook NOW on BookMyShow!`,
          "urgent",
          "rotating_light,movie_camera"
        );
      }
    }
  }
}

// ============== District.in CHECKER ==============
async function checkDistrict() {
  console.log(`[DISTRICT] Checking District.in...`);

  // Approach 1: District.in movie page
  try {
    const url = `https://www.district.in/movies/${CONFIG.DISTRICT_SLUG}`;
    const resp = await axios.get(url, {
      headers: {
        "User-Agent": randomUA(),
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
      },
      timeout: 15000,
    });

    const html = resp.data.toLowerCase();
    checkRawDataForCinemas(html, "any", "District.in");

    // Also parse structured data (JSON-LD or __NEXT_DATA__) from the page
    const $ = cheerio.load(resp.data);
    const nextDataEl = $("#__NEXT_DATA__").html();
    if (nextDataEl) {
      try {
        const nextData = JSON.parse(nextDataEl);
        const jsonStr = JSON.stringify(nextData).toLowerCase();
        checkRawDataForCinemas(jsonStr, "any", "District.in-NextData");
        console.log(`[DISTRICT] Parsed __NEXT_DATA__: ${jsonStr.length} chars`);
      } catch (_) {}
    }

    console.log(`[DISTRICT] Movie page: Got ${html.length} chars`);
  } catch (err) {
    console.log(`[DISTRICT] Web scrape error: ${err.message}`);
  }

  // Approach 2: Try District.in internal APIs with different known formats
  for (const date of CONFIG.TARGET_DATES) {
    const districtApis = [
      `https://www.district.in/_next/data/movies/${CONFIG.DISTRICT_MOVIE_ID}/showtimes.json?city=hyderabad&date=${date}`,
      `https://www.district.in/api/v1/movies/${CONFIG.DISTRICT_MOVIE_ID}/showtimes?city=hyderabad&date=${date}`,
      `https://www.district.in/movies/showtimes/${CONFIG.DISTRICT_MOVIE_ID}?city=hyderabad&date=${date}`,
    ];

    for (const apiUrl of districtApis) {
      try {
        const resp = await axios.get(apiUrl, {
          headers: {
            "User-Agent": randomUA(),
            Accept: "application/json, text/plain, */*",
            Referer: `https://www.district.in/movies/${CONFIG.DISTRICT_SLUG}`,
          },
          timeout: 10000,
        });

        const data = resp.data;
        if (data) {
          const jsonStr = JSON.stringify(data).toLowerCase();
          checkRawDataForCinemas(jsonStr, date, "District.in-API");
          console.log(`[DISTRICT] API hit for ${date}: ${jsonStr.length} chars`);
        }
      } catch (_) {
        // Expected to fail for some endpoints
      }
    }
  }
}

// ============== Generic raw text search ==============
function checkRawDataForCinemas(text, date, source) {
  for (const cinema of CONFIG.TARGET_CINEMAS) {
    if (text.includes(cinema)) {
      if (date === "any") {
        const hasDate = CONFIG.TARGET_DATE_LABELS.some((d) => text.includes(d));
        if (hasDate || CONFIG.TARGET_DATES.some((d) => text.includes(d))) {
          sendNotification(
            `Dhurandhar 2 - ${cinema.toUpperCase()} detected!`,
            `${source} shows ${cinema} cinema with matching dates!\nCheck ${source} immediately to book!`,
            "urgent",
            "rotating_light,movie_camera"
          );
        } else {
          sendNotification(
            `Dhurandhar 2 - ${cinema.toUpperCase()} listed!`,
            `${source} mentions ${cinema} cinema for Dhurandhar 2.\nDates not confirmed yet - keep checking!\nTarget: Mar 19 & 21, 2026`,
            "high",
            "movie_camera,eyes"
          );
        }
      } else {
        sendNotification(
          `Dhurandhar 2 at ${cinema.toUpperCase()} on ${date}!`,
          `${source} shows ${cinema} has Dhurandhar 2 on ${date}!\nBOOK NOW before seats fill up!`,
          "urgent",
          "rotating_light,movie_camera"
        );
      }
    }
  }
}

// ============== ALTERNATIVE: Direct BMS showtime page scrape ==============
async function checkBMSShowtimesPage() {
  console.log(`[BMS-PAGE] Checking BMS showtimes pages...`);

  for (const date of CONFIG.TARGET_DATES) {
    const dateForUrl = date.replace(/-/g, "");
    for (const eventId of CONFIG.BMS_EVENT_IDS) {
      try {
        const url = `https://in.bookmyshow.com/movies/${CONFIG.BMS_REGION}/dhurandhar-part-2-the-revenge/buytickets/${eventId}/${dateForUrl}`;
        const resp = await axios.get(url, {
          headers: {
            "User-Agent": randomUA(),
            Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.9",
            "Cache-Control": "no-cache",
            Referer: "https://in.bookmyshow.com/explore/home/hyderabad",
          },
          timeout: 15000,
          maxRedirects: 5,
        });

        const $ = cheerio.load(resp.data);
        const pageText = $.text().toLowerCase();

        // Also try extracting __NEXT_DATA__ or inline JSON
        let extraData = "";
        $("script").each((_, el) => {
          const scriptContent = $(el).html() || "";
          if (scriptContent.includes("sln") || scriptContent.includes("aparna") || scriptContent.includes("ShowDetails")) {
            extraData += scriptContent.toLowerCase();
          }
        });

        const combined = pageText + " " + extraData;
        for (const cinema of CONFIG.TARGET_CINEMAS) {
          if (combined.includes(cinema)) {
            sendNotification(
              `BOOK NOW! Dhurandhar 2 at ${cinema.toUpperCase()} on ${date}!`,
              `BookMyShow confirms ${cinema} has shows on ${date}!\nLink: https://in.bookmyshow.com/movies/${CONFIG.BMS_REGION}/dhurandhar-part-2-the-revenge/buytickets/${eventId}/${dateForUrl}`,
              "urgent",
              "rotating_light,ticket"
            );
          }
        }
        console.log(`[BMS-PAGE] ${eventId} ${date}: Got ${combined.length} chars`);
      } catch (err) {
        if (err.response?.status !== 403) {
          console.log(`[BMS-PAGE] ${eventId} ${date}: ${err.message}`);
        }
      }
    }
  }
}

// ============== GOOGLE SEARCH FALLBACK ==============
async function checkGoogleFallback() {
  console.log(`[GOOGLE] Checking via Google search cache...`);
  const queries = [
    "dhurandhar+2+sln+platinum+hyderabad+bookmyshow",
    "dhurandhar+2+aparna+cinemas+hyderabad+bookmyshow",
    "dhurandhar+revenge+sln+platinum+hyderabad",
    "dhurandhar+revenge+aparna+cinemas+hyderabad",
  ];

  for (const q of queries) {
    try {
      const url = `https://www.google.com/search?q=${q}&num=5`;
      const resp = await axios.get(url, {
        headers: {
          "User-Agent": randomUA(),
          Accept: "text/html",
        },
        timeout: 10000,
      });

      const text = resp.data.toLowerCase();
      // Check if Google results mention our cinemas with the movie
      const hasSLN = text.includes("sln platinum") && text.includes("dhurandhar");
      const hasAparna = text.includes("aparna") && text.includes("dhurandhar");

      if (hasSLN) {
        const hasDate = CONFIG.TARGET_DATE_LABELS.some((d) => text.includes(d));
        sendNotification(
          "Dhurandhar 2 - SLN Platinum found via Google!",
          `Google search results show Dhurandhar 2 at SLN Platinum Cinemas!${hasDate ? " Date match found!" : ""}\nCheck BookMyShow/District now!`,
          "high",
          "mag,movie_camera"
        );
      }
      if (hasAparna) {
        const hasDate = CONFIG.TARGET_DATE_LABELS.some((d) => text.includes(d));
        sendNotification(
          "Dhurandhar 2 - Aparna Cinemas found via Google!",
          `Google search results show Dhurandhar 2 at Aparna Cinemas!${hasDate ? " Date match found!" : ""}\nCheck BookMyShow/District now!`,
          "high",
          "mag,movie_camera"
        );
      }
    } catch (_) {
      // Google blocks are common, ignore
    }
  }
}

// ============== MAIN CHECK FUNCTION ==============
async function runCheck() {
  const now = new Date();
  console.log(`\n========================================`);
  console.log(`[CHECK] Running at ${now.toISOString()}`);
  console.log(`========================================`);

  // Stop checking after March 22, 2026
  if (now > new Date("2026-03-22T00:00:00+05:30")) {
    console.log("[DONE] Past target dates. Stopping checks.");
    sendNotification(
      "Dhurandhar 2 Notifier Stopped",
      "Target dates (Mar 19 & 21) have passed. Notifier is stopping.",
      "low",
      "checkered_flag"
    );
    process.exit(0);
  }

  try {
    await Promise.allSettled([
      checkBookMyShow(),
      checkDistrict(),
      checkBMSShowtimesPage(),
      checkGoogleFallback(),
    ]);
  } catch (err) {
    console.error(`[ERROR] Check failed:`, err.message);
  }

  console.log(`[CHECK] Done. Next check in 5 minutes.`);
}

// ============== HEALTH CHECK SERVER (for Render.com) ==============
const http = require("http");
const PORT = process.env.PORT || 3000;

const server = http.createServer((req, res) => {
  if (req.url === "/health" || req.url === "/") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        status: "running",
        movie: "Dhurandhar 2: The Revenge",
        targetCinemas: CONFIG.TARGET_CINEMAS,
        targetDates: CONFIG.TARGET_DATES,
        ntfyTopic: CONFIG.NTFY_TOPIC,
        lastCheck: new Date().toISOString(),
        notificationsSent: CONFIG.sentNotifications.size,
      })
    );
  } else {
    res.writeHead(404);
    res.end("Not found");
  }
});

server.listen(PORT, () => {
  console.log(`\nDhurandhar 2 Notifier Server running on port ${PORT}`);
  console.log(`ntfy topic: ${CONFIG.NTFY_TOPIC}`);
  console.log(`Cinemas: ${CONFIG.TARGET_CINEMAS.join(", ")}`);
  console.log(`Dates: ${CONFIG.TARGET_DATES.join(", ")}`);
  console.log(`Checking every 5 minutes\n`);
});

// ============== START ==============
// Run immediately on startup
runCheck();

// Then schedule every 5 minutes
cron.schedule(CONFIG.CRON_SCHEDULE, () => {
  runCheck();
});

// Send startup notification
sendNotification(
  "Dhurandhar 2 Notifier Started!",
  `Monitoring:\n- BookMyShow & District.in\n- SLN Platinum & Aparna Cinemas\n- Dates: Mar 19 & 21, 2026\n- Checking every 5 minutes`,
  "default",
  "rocket,movie_camera"
);
