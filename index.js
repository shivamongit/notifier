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

  // Target cinemas (lowercase for matching - multiple variants to catch all listings)
  TARGET_CINEMAS: [
    { keywords: ["sln platinum", "platinum movietime", "sln terminus", "platinum movietime cinemas, gachibowli"], label: "SLN Platinum (Gachibowli)" },
    { keywords: ["aparna cinema", "aparna cine"], label: "Aparna Cinemas (Nallagandla)" },
  ],

  // Target dates
  TARGET_DATES: ["2026-03-19", "2026-03-21"],
  TARGET_DATE_LABELS: ["19 mar", "21 mar", "march 19", "march 21", "19/03", "21/03", "wed 19", "fri 21"],

  // BookMyShow event IDs for Dhurandhar 2: The Revenge
  BMS_EVENT_IDS: ["ET00478890", "ET00478891"],
  BMS_CITY_CODE: "HYDR",
  BMS_REGION: "hyderabad",

  // District.in movie ID (MV211577 = Dhurandhar: The Revenge, MV201380 = original Dhurandhar)
  DISTRICT_MOVIE_ID: "MV211577",
  DISTRICT_SLUG: "dhurandhar-the-revenge-movie-tickets-in-hyderabad-MV211577",

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

// Helper: check if text matches any cinema keywords
function matchCinema(text) {
  const lower = text.toLowerCase();
  for (const cinema of CONFIG.TARGET_CINEMAS) {
    if (cinema.keywords.some((kw) => lower.includes(kw))) {
      return cinema.label;
    }
  }
  return null;
}

function processBookMyShowData(showDetails, date) {
  for (const venue of showDetails) {
    const venueName = venue.VenueName || venue.CinemaName || "";
    const matched = matchCinema(venueName);
    if (matched) {
      const shows = venue.ShowTimes || venue.Shows || [];
      const showInfo = shows.map((s) => s.ShowTime || s.Time || "").join(", ") || "Check app for times";
      sendNotification(
        `Dhurandhar 2 FOUND at ${matched} on ${date}!`,
        `${venueName} has shows on ${date}!\nTimes: ${showInfo}\nBook NOW on BookMyShow!`,
        "urgent",
        "rotating_light,movie_camera"
      );
    }
  }
}

function processBookMyShowCinemas(cinemas, date) {
  for (const cinema of cinemas) {
    const cinemaName = cinema.name || cinema.cinemaName || cinema.CinemaName || "";
    const matched = matchCinema(cinemaName);
    if (matched) {
      sendNotification(
        `Dhurandhar 2 FOUND at ${matched} on ${date}!`,
        `${cinemaName} has shows on ${date}!\nBook NOW on BookMyShow!`,
        "urgent",
        "rotating_light,movie_camera"
      );
    }
  }
}

// ============== District.in CHECKER (with showtime extraction) ==============
async function checkDistrict() {
  console.log(`[DISTRICT] Checking District.in...`);

  for (const date of CONFIG.TARGET_DATES) {
    try {
      const url = `https://www.district.in/movies/${CONFIG.DISTRICT_SLUG}?fromdate=${date}`;
      const resp = await axios.get(url, {
        headers: {
          "User-Agent": randomUA(),
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.9",
        },
        timeout: 15000,
      });

      const $ = cheerio.load(resp.data);
      const fullText = $.text();

      // Extract cinema blocks: each cinema listing has a name followed by showtimes
      for (const cinema of CONFIG.TARGET_CINEMAS) {
        const matched = cinema.keywords.some((kw) => fullText.toLowerCase().includes(kw));
        if (matched) {
          // Try to extract showtimes near the cinema name
          const showtimes = extractShowtimes(fullText, cinema.keywords);
          const dateLabel = formatDateLabel(date);

          if (showtimes.length > 0) {
            const availableShows = showtimes.filter((s) => !s.soldOut);
            const soldOutShows = showtimes.filter((s) => s.soldOut);

            let msg = `YES! SHOWS AVAILABLE at ${cinema.label} on ${dateLabel}\n\n`;
            if (availableShows.length > 0) {
              msg += `AVAILABLE:\n${availableShows.map((s) => `  ${s.time}${s.format ? " (" + s.format + ")" : ""}`).join("\n")}\n`;
            }
            if (soldOutShows.length > 0) {
              msg += `\nSOLD OUT:\n${soldOutShows.map((s) => `  ${s.time}${s.format ? " (" + s.format + ")" : ""}`).join("\n")}\n`;
            }
            msg += `\nBook: district.in/movies/${CONFIG.DISTRICT_SLUG}?fromdate=${date}`;

            sendNotification(
              `SHOWS AVAILABLE - ${cinema.label} - ${dateLabel}`,
              msg,
              "urgent",
              "rotating_light,ticket"
            );
          } else {
            // Cinema is listed but no specific showtimes could be parsed
            sendNotification(
              `${cinema.label} LISTED for ${dateLabel}`,
              `${cinema.label} is listed on District.in for ${dateLabel} but exact showtimes could not be parsed.\nCheck manually: district.in/movies/${CONFIG.DISTRICT_SLUG}?fromdate=${date}`,
              "high",
              "movie_camera,eyes"
            );
          }
        }
      }

      console.log(`[DISTRICT] Page for ${date}: ${fullText.length} chars`);
    } catch (err) {
      console.log(`[DISTRICT] Error for ${date}: ${err.message}`);
    }
  }

  // Also check default page (no date filter) for general listing
  try {
    const url = `https://www.district.in/movies/${CONFIG.DISTRICT_SLUG}`;
    const resp = await axios.get(url, {
      headers: { "User-Agent": randomUA(), Accept: "text/html" },
      timeout: 15000,
    });
    const html = resp.data.toLowerCase();
    checkRawDataForCinemas(html, "any", "District.in");
  } catch (_) {}
}

// Extract showtimes from page text near a cinema name
function extractShowtimes(fullText, cinemaKeywords) {
  const showtimes = [];
  const lower = fullText.toLowerCase();

  // Find the position of the cinema name in the text
  let cinemaPos = -1;
  for (const kw of cinemaKeywords) {
    const idx = lower.indexOf(kw);
    if (idx !== -1) {
      cinemaPos = idx;
      break;
    }
  }
  if (cinemaPos === -1) return showtimes;

  // Extract a chunk of text after the cinema name (showtimes are listed right after)
  const chunk = fullText.substring(cinemaPos, cinemaPos + 1000);

  // Match time patterns like "05:30 PM", "10:00 PM", etc.
  const timeRegex = /(\d{1,2}:\d{2}\s*[AP]M)/gi;
  const matches = [...chunk.matchAll(timeRegex)];

  for (const match of matches) {
    const time = match[1].trim();
    const posAfterTime = match.index + match[0].length;
    const afterTime = chunk.substring(posAfterTime, posAfterTime + 80).toLowerCase();

    const soldOut = afterTime.includes("no tickets") || afterTime.includes("sold out") || afterTime.includes("not available");

    // Check for format tags like DOLBY ATMOS, RECLINER, ATMOS etc.
    let format = "";
    const formatMatch = afterTime.match(/(dolby\s*atmos|atmos|recliner|dolby\s*7\.1|laser|4dx|imax)/i);
    if (formatMatch) format = formatMatch[1].toUpperCase();

    // Also check text before the time for format
    if (!format) {
      const beforeTime = chunk.substring(Math.max(0, match.index - 40), match.index).toLowerCase();
      const beforeMatch = beforeTime.match(/(dolby\s*atmos|atmos|recliner|dolby\s*7\.1|laser|4dx|imax)/i);
      if (beforeMatch) format = beforeMatch[1].toUpperCase();
    }

    showtimes.push({ time, soldOut, format });
  }

  return showtimes;
}

function formatDateLabel(dateStr) {
  const d = new Date(dateStr + "T00:00:00+05:30");
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${days[d.getDay()]}, ${months[d.getMonth()]} ${d.getDate()}`;
}

// ============== Generic raw text search ==============
function checkRawDataForCinemas(text, date, source) {
  const lower = text.toLowerCase();
  for (const cinema of CONFIG.TARGET_CINEMAS) {
    const found = cinema.keywords.some((kw) => lower.includes(kw));
    if (found) {
      // Try to extract showtimes from raw text
      const showtimes = extractShowtimes(text, cinema.keywords);
      const timesStr = showtimes.length > 0
        ? showtimes.map((s) => `${s.time}${s.soldOut ? " (SOLD OUT)" : ""}${s.format ? " [" + s.format + "]" : ""}`).join(", ")
        : "Could not parse times";

      if (date === "any") {
        const hasDate = CONFIG.TARGET_DATE_LABELS.some((d) => lower.includes(d));
        if (hasDate || CONFIG.TARGET_DATES.some((d) => lower.includes(d))) {
          sendNotification(
            `SHOWS FOUND - ${cinema.label}!`,
            `YES! ${source} shows ${cinema.label} has Dhurandhar 2!\nShowtimes: ${timesStr}\nCheck ${source} immediately to book!`,
            "urgent",
            "rotating_light,movie_camera"
          );
        } else {
          sendNotification(
            `${cinema.label} listed (dates not confirmed)`,
            `${source} mentions ${cinema.label} for Dhurandhar 2.\nShowtimes: ${timesStr}\nTarget dates (Mar 19 & 21) NOT confirmed yet - keep checking!`,
            "high",
            "movie_camera,eyes"
          );
        }
      } else {
        const dateLabel = formatDateLabel(date);
        sendNotification(
          `SHOWS AVAILABLE - ${cinema.label} - ${dateLabel}!`,
          `YES! ${cinema.label} has Dhurandhar 2 on ${dateLabel}!\nShowtimes: ${timesStr}\nBOOK NOW before seats fill up!\n\nBookMyShow: in.bookmyshow.com/movies/hyderabad/dhurandhar-the-revenge/buytickets/ET00478890\nDistrict: district.in/movies/${CONFIG.DISTRICT_SLUG}?fromdate=${date}`,
          "urgent",
          "rotating_light,ticket"
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
          if (scriptContent.includes("sln") || scriptContent.includes("platinum movietime") || scriptContent.includes("aparna") || scriptContent.includes("ShowDetails")) {
            extraData += scriptContent.toLowerCase();
          }
        });

        const combined = pageText + " " + extraData;
        for (const cinema of CONFIG.TARGET_CINEMAS) {
          const found = cinema.keywords.some((kw) => combined.includes(kw));
          if (found) {
            sendNotification(
              `BOOK NOW! Dhurandhar 2 at ${cinema.label} on ${date}!`,
              `BookMyShow confirms ${cinema.label} has shows on ${date}!\nLink: https://in.bookmyshow.com/movies/${CONFIG.BMS_REGION}/dhurandhar-the-revenge/buytickets/${eventId}/${dateForUrl}`,
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

// ============== DAILY STATUS SUMMARY ==============
let lastSummaryDate = "";
async function sendDailySummary() {
  const now = new Date();
  const todayStr = now.toISOString().split("T")[0];
  if (lastSummaryDate === todayStr) return;

  // Send summary at 8 AM IST (2:30 UTC)
  const istHour = (now.getUTCHours() + 5.5) % 24;
  if (istHour < 8 || istHour > 9) return;

  lastSummaryDate = todayStr;

  let summary = `DAILY STATUS - ${formatDateLabel(todayStr)}\n\n`;
  for (const cinema of CONFIG.TARGET_CINEMAS) {
    summary += `${cinema.label}:\n`;
    for (const date of CONFIG.TARGET_DATES) {
      const dateLabel = formatDateLabel(date);
      // Check District.in for this cinema+date
      try {
        const url = `https://www.district.in/movies/${CONFIG.DISTRICT_SLUG}?fromdate=${date}`;
        const resp = await axios.get(url, {
          headers: { "User-Agent": randomUA(), Accept: "text/html" },
          timeout: 15000,
        });
        const $page = cheerio.load(resp.data);
        const fullText = $page.text();
        const lower = fullText.toLowerCase();
        const found = cinema.keywords.some((kw) => lower.includes(kw));
        if (found) {
          const showtimes = extractShowtimes(fullText, cinema.keywords);
          if (showtimes.length > 0) {
            const avail = showtimes.filter((s) => !s.soldOut);
            summary += `  ${dateLabel}: YES (${avail.length} available, ${showtimes.length - avail.length} sold out)\n`;
            summary += `    Times: ${showtimes.map((s) => s.time + (s.soldOut ? "[SOLD]" : "")).join(", ")}\n`;
          } else {
            summary += `  ${dateLabel}: LISTED (times not parsed)\n`;
          }
        } else {
          summary += `  ${dateLabel}: NOT AVAILABLE YET\n`;
        }
      } catch (_) {
        summary += `  ${dateLabel}: Could not check\n`;
      }
    }
    summary += "\n";
  }
  summary += "Notifier is running 24/7. You will get an instant alert when shows open.";

  sendNotification(
    `Daily Status - Dhurandhar 2 Notifier`,
    summary,
    "default",
    "clipboard,movie_camera"
  );
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

  // Try sending daily summary (only sends once per day at 8 AM IST)
  try {
    await sendDailySummary();
  } catch (_) {}

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
  console.log(`Cinemas: ${CONFIG.TARGET_CINEMAS.map((c) => c.label).join(", ")}`);
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
  `Monitoring BookMyShow & District.in for:\n- SLN Platinum (Gachibowli) & Aparna Cinemas (Nallagandla)\n- Dates: Mar 19 & 21, 2026\n- Checking every 5 minutes 24/7\n\nYou will get a notification with EXACT SHOWTIMES the moment shows are available.\nIf shows are NOT available yet, you will NOT be spammed.\nDaily status update at 8 AM IST.`,
  "default",
  "rocket,movie_camera"
);
