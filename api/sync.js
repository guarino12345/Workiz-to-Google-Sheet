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
        `${info.timestamp} [${info.level.toUpperCase()}] ${info.message}`
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
    logger.warn(`Failed to delete temp creds file: ${err.message}`)
  );

  logger.info("Authenticated with Google Sheets API.");
  return google.sheets("v4");
}

// Fetch job list from Workiz API
async function fetchJobs(apiToken, startDate, endDate) {
  const url = `https://api.workiz.com/api/v1/${apiToken}/job/all/`;
  const params = {
    start_date: startDate,
    end_date: endDate, // Add end date to parameters
    offset: 0,
    records: 100,
    only_open: false,
  };

  logger.info(`Fetching jobs from ${startDate} to ${endDate}`);
  try {
    const response = await axios.get(url, { params, timeout: 15000 });
    return response.data.data || [];
  } catch (error) {
    const msg = error.response
      ? JSON.stringify(error.response.data)
      : error.message;
    logger.error(`Workiz API error: ${msg}`);
    throw error;
  }
}

async function getSheetRows(sheets, spreadsheetId, sheetName) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${sheetName}!A2:Z`,
  });
  const rows = res.data.values || [];
  logger.info(`Retrieved ${rows.length} rows from Google Sheet.`);
  return rows;
}

function findRowIndex(rows, jobUUID) {
  return rows.findIndex((row) => row[0] === jobUUID);
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

async function updateSheetRow(
  sheets,
  spreadsheetId,
  sheetName,
  rowNumber,
  values
) {
  const range = `${sheetName}!A${rowNumber}:Z${rowNumber}`;
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range,
    valueInputOption: "RAW",
    requestBody: { values: [values] },
  });
  logger.info(`Updated row #${rowNumber} for job ${values[0]}`);
}

async function appendSheetRow(sheets, spreadsheetId, sheetName, values) {
  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: `${sheetName}!A1:Z1`,
    valueInputOption: "RAW",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values: [values] },
  });
  logger.info(`Appended new row for job ${values[0]}`);
}

async function syncJobsWithSheet(sheets, spreadsheetId, sheetName, jobs) {
  const rows = await getSheetRows(sheets, spreadsheetId, sheetName);

  for (const job of jobs) {
    const uuid = job.UUID;
    if (!uuid) {
      logger.warn("Skipping job with missing UUID");
      continue;
    }

    const data = formatJobData(job);
    const index = findRowIndex(rows, uuid);

    if (index !== -1) {
      await updateSheetRow(sheets, spreadsheetId, sheetName, index + 2, data);
      rows[index] = data;
    } else {
      await appendSheetRow(sheets, spreadsheetId, sheetName, data);
      rows.push(data);
    }
  }
}

// MAIN HANDLER
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

  const { startDate, endDate } = req.body; // Get end date from request body
  let dateToUse = startDate;

  if (!startDate || !/^\d{4}-\d{2}-\d{2}$/.test(startDate)) {
    const fallback = new Date();
    fallback.setDate(fallback.getDate() - 7);
    dateToUse = fallback.toISOString().split("T")[0];
  }

  logger.info(`Received sync request starting from ${dateToUse}`);

  try {
    const sheets = await authenticateGoogleSheets(
      GOOGLE_APPLICATION_CREDENTIALS
    );
    const jobs = await fetchJobs(WORKIZ_API_TOKEN, dateToUse, endDate); // Pass end date

    if (!jobs.length) {
      return res.status(200).json({ message: "No jobs found." });
    }

    await syncJobsWithSheet(sheets, SPREADSHEET_ID, SHEET_NAME, jobs);

    res
      .status(200)
      .json({ message: "Sync complete.", jobsSynced: jobs.length });
  } catch (err) {
    logger.error(`Sync failed: ${err.message}`);
    res.status(500).json({ error: `Sync failed: ${err.message}` });
  }
}
