import { google } from "googleapis";
import axios from "axios";
import winston from "winston";
import fs from "fs/promises";
import os from "os";
import path from "path";

// Setup logger
const logger = winston.createLogger({
  level: "info",
  format: winston.format.combine(
    winston.format.timestamp({ format: "YYYY-MM-DD HH:mm:ss" }),
    winston.format.printf(
      (info) =>
        info.timestamp + " [" + info.level.toUpperCase() + "] " + info.message
    )
  ),
  transports: [new winston.transports.Console()],
});

// Authenticate with Google Sheets using base64-encoded service account key
async function authenticateGoogleSheets(encodedKey) {
  const tempFilePath = path.join(os.tmpdir(), `gcreds-${Date.now()}.json`);
  const jsonKey = Buffer.from(encodedKey, "base64").toString("utf8");
  await fs.writeFile(tempFilePath, jsonKey);

  const auth = new google.auth.GoogleAuth({
    keyFile: tempFilePath,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });

  const authClient = await auth.getClient();
  google.options({ auth: authClient });

  // Clean up the temp file asynchronously (don’t block)
  fs.unlink(tempFilePath).catch((err) =>
    logger.warn("Failed to delete temp creds file: " + err.message)
  );

  logger.info("Authenticated with Google Sheets API.");
  return google.sheets("v4");
}

// Fetch job list from Workiz API, filtering by jobSources if provided
async function fetchJobs(apiToken, startDate, jobSources) {
  const url = `https://api.workiz.com/api/v1/${apiToken}/job/all/`;
  const params = {
    start_date: startDate,
    offset: 0,
    records: 100,
    only_open: false,
  };

  logger.info("Fetching jobs from " + startDate);
  try {
    const response = await axios.get(url, { params, timeout: 15000 });
    let jobs = response.data.data || [];

    // Filter by jobSources if provided (case-insensitive)
    if (Array.isArray(jobSources) && jobSources.length > 0) {
      const jobSourcesSet = new Set(jobSources.map((s) => s.toLowerCase()));
      jobs = jobs.filter(
        (job) => job.JobSource && jobSourcesSet.has(job.JobSource.toLowerCase())
      );
    }

    return jobs;
  } catch (error) {
    const msg = error.response
      ? JSON.stringify(error.response.data)
      : error.message;
    logger.error("Workiz API error: " + msg);
    throw error;
  }
}

async function getSheetRows(sheets, spreadsheetId, sheetName) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${sheetName}!A2:AM`, // columns A to AM = 39 columns
  });
  const rows = res.data.values || [];
  logger.info("Retrieved " + rows.length + " rows from Google Sheet.");
  return rows;
}

function formatJobData(job) {
  const fields = [
    "UUID",
    "SerialId",
    "JobDateTime",
    "JobEndDateTime",
    "CreatedDate",
    "JobTotalPrice",
    "JobAmountDue",
    "SubTotal",
    "item_cost",
    "tech_cost",
    "ClientId",
    "Status",
    "SubStatus",
    "PaymentDueDate",
    "Phone",
    "SecondPhone",
    "PhoneExt",
    "SecondPhoneExt",
    "Email",
    "Comments",
    "FirstName",
    "LastName",
    "Company",
    "Address",
    "City",
    "State",
    "PostalCode",
    "Country",
    "Unit",
    "Latitude",
    "Longitude",
    "JobType",
    "ReferralCompany",
    "Timezone",
    "JobNotes",
    "JobSource",
    "CreatedBy",
    "ServiceArea",
    "LastStatusUpdate",
  ];

  return fields.map((field) => {
    let val = job[field];
    if (Array.isArray(val)) {
      if (field === "Tags") {
        val = val.map((t) => (typeof t === "object" ? t.tag : t)).join(",");
      } else if (field === "Team") {
        val = val.map((t) => (typeof t === "object" ? t.name : t)).join(",");
      } else {
        val = JSON.stringify(val);
      }
    }
    return val != null ? String(val) : "";
  });
}

/**
 * Batch update or append all job rows at once to avoid quota exceeded error.
 */
async function batchSyncJobsWithSheet(sheets, spreadsheetId, sheetName, jobs) {
  const rows = await getSheetRows(sheets, spreadsheetId, sheetName);

  // Map job UUID -> row index (0-based)
  const uuidToRowIndex = new Map();
  rows.forEach((row, idx) => {
    if (row[0]) uuidToRowIndex.set(row[0], idx);
  });

  logger.info("Existing rows UUID count: " + uuidToRowIndex.size);

  const updates = [];
  const appends = [];

  for (const job of jobs) {
    const uuid = job.UUID;
    if (!uuid) {
      logger.warn("Skipping job with missing UUID");
      continue;
    }

    const data = formatJobData(job);
    const existingIndex = uuidToRowIndex.get(uuid);

    if (existingIndex !== undefined) {
      // Update existing row (row number = index+2)
      updates.push({
        range: `${sheetName}!A${existingIndex + 2}:AM${existingIndex + 2}`,
        values: [data],
      });
    } else {
      appends.push(data);
    }
  }

  if (updates.length > 0) {
    logger.info("Batch updating " + updates.length + " rows...");
    await batchUpdateRows(sheets, spreadsheetId, updates);
  }

  if (appends.length > 0) {
    logger.info("Appending " + appends.length + " new rows...");
    // IMPORTANT: Use just sheetName in append range to append at bottom without overwriting
    await batchAppendRows(sheets, spreadsheetId, sheetName, appends);
  }
}

async function batchUpdateRows(sheets, spreadsheetId, updates) {
  const data = updates.map((u) => ({
    range: u.range,
    values: u.values,
  }));

  try {
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId,
      requestBody: {
        valueInputOption: "RAW",
        data,
      },
    });
    logger.info("Batch update successful for " + updates.length + " rows.");
  } catch (error) {
    logger.error("Batch update error: " + error.message);
    await handleQuotaBackoff(error, () =>
      batchUpdateRows(sheets, spreadsheetId, updates)
    );
  }
}

async function batchAppendRows(sheets, spreadsheetId, sheetName, rows) {
  try {
    await sheets.spreadsheets.values.append({
      spreadsheetId,
      range: sheetName, // Append at the bottom safely
      valueInputOption: "RAW",
      insertDataOption: "INSERT_ROWS",
      requestBody: { values: rows },
    });
    logger.info("Batch append successful for " + rows.length + " rows.");
  } catch (error) {
    logger.error("Batch append error: " + error.message);
    await handleQuotaBackoff(error, () =>
      batchAppendRows(sheets, spreadsheetId, sheetName, rows)
    );
  }
}

async function handleQuotaBackoff(error, retryFunction, retries = 0) {
  const maxRetries = 5;
  const isQuotaError =
    error.code === 429 ||
    (error.errors &&
      error.errors.some((e) => e.reason === "userRateLimitExceeded"));

  if (isQuotaError && retries < maxRetries) {
    const delay = Math.min(1000 * 2 ** retries, 30000);
    logger.warn(
      "Quota exceeded, retrying after " +
        delay +
        " ms (attempt " +
        (retries + 1) +
        ")"
    );
    await new Promise((resolve) => setTimeout(resolve, delay));
    return retryFunction(retries + 1);
  }
  throw error;
}

// New function to fetch detailed job info for each UUID in the sheet and update rows accordingly
async function fetchAndUpdateDetailedJobs(
  sheets,
  spreadsheetId,
  sheetName,
  apiToken
) {
  const rows = await getSheetRows(sheets, spreadsheetId, sheetName);
  const uuidToRowIndex = new Map();
  rows.forEach((row, idx) => {
    if (row[0]) {
      uuidToRowIndex.set(row[0], idx);
    }
  });

  const concurrencyLimit = 5;
  const uuids = Array.from(uuidToRowIndex.keys());
  const updates = [];

  async function processInBatches(items, batchSize, processor) {
    let index = 0;
    const results = [];
    async function next() {
      if (index >= items.length) return;
      const currentIndex = index++;
      try {
        results[currentIndex] = await processor(
          items[currentIndex],
          currentIndex
        );
      } catch (err) {
        results[currentIndex] = null;
        logger.error(err.message || err);
      }
      await next();
    }
    const workers = [];
    for (let i = 0; i < batchSize; i++) {
      workers.push(next());
    }
    await Promise.all(workers);
    return results;
  }

  await processInBatches(uuids, concurrencyLimit, async (uuid) => {
    try {
      const detailUrl =
        "https://api.workiz.com/api/v1/" + apiToken + "/job/get/" + uuid + "/";
      const response = await axios.get(detailUrl, { timeout: 15000 });
      const detailedJob = response.data.data;

      if (!detailedJob) {
        logger.warn("No details found for job UUID " + uuid);
        return;
      }

      const detailedData = formatJobData(detailedJob);
      const rowIndex = uuidToRowIndex.get(uuid);
      updates.push({
        range: sheetName + "!A" + (rowIndex + 2) + ":AM" + (rowIndex + 2),
        values: [detailedData],
      });
    } catch (err) {
      logger.error(
        "Failed to fetch details for UUID " + uuid + ": " + err.message
      );
    }
  });

  if (updates.length > 0) {
    logger.info("Batch updating " + updates.length + " detailed job rows...");
    await batchUpdateRows(sheets, spreadsheetId, updates);
  } else {
    logger.info("No detailed job rows to update.");
  }
}

// Main handler
export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Use POST only." });
  }

  const {
    WORKIZ_API_TOKEN,
    SPREADSHEET_ID,
    GOOGLE_APPLICATION_CREDENTIALS,
    SHEET_NAME = "Sheet1",
  } = process.env;

  if (!WORKIZ_API_TOKEN || !SPREADSHEET_ID || !GOOGLE_APPLICATION_CREDENTIALS) {
    return res.status(500).json({
      error:
        "Missing environment variables: WORKIZ_API_TOKEN, SPREADSHEET_ID, or GOOGLE_APPLICATION_CREDENTIALS.",
    });
  }

  const { startDate, endDate, jobSources } = req.body;
  let dateToUse = startDate;

  if (!startDate || !/^\d{4}-\d{2}-\d{2}$/.test(startDate)) {
    const fallback = new Date();
    fallback.setDate(fallback.getDate() - 7);
    dateToUse = fallback.toISOString().split("T")[0];
  }

  logger.info("Received sync request starting from " + dateToUse);

  try {
    const sheets = await authenticateGoogleSheets(
      GOOGLE_APPLICATION_CREDENTIALS
    );
    const jobs = await fetchJobs(WORKIZ_API_TOKEN, dateToUse, jobSources);

    if (!jobs.length) {
      return res.status(200).json({ message: "No jobs found." });
    }

    // Filter by endDate if provided
    const filteredJobs = endDate
      ? jobs.filter((job) => {
          const jobDate = new Date(job.JobDateTime);
          const start = new Date(startDate + "T00:00:00");
          const end = new Date(endDate + "T23:59:59");
          logger.info(
            "Filtering job: " + job.UUID + ", JobDateTime: " + job.JobDateTime
          );
          return jobDate >= start && jobDate <= end;
        })
      : jobs;

    await batchSyncJobsWithSheet(
      sheets,
      SPREADSHEET_ID,
      SHEET_NAME,
      filteredJobs
    );

    // After initial sync, fetch detailed job info and update corresponding rows
    await fetchAndUpdateDetailedJobs(
      sheets,
      SPREADSHEET_ID,
      SHEET_NAME,
      WORKIZ_API_TOKEN
    );

    res
      .status(200)
      .json({
        message: "Sync complete including detailed updates.",
        jobsSynced: filteredJobs.length,
      });
  } catch (err) {
    logger.error("Sync failed: " + err.message);
    res.status(500).json({ error: "Sync failed: " + err.message });
  }
}
