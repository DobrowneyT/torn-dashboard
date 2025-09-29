# Torn City OC 2.0 Management System

Automated crime tracking, CPR management, and payout processing for Torn City organized crime factions.

## Features

- **Daily Crime Data Updates**: Automatically pulls new crime data from Torn API
- **CPR Scraping**: Triggered manually to collect member CPR data from available crime slots  
- **Weekly Payout Processing**: Calculates member payments based on time spent and tier levels
- **Google Sheets Integration**: Updates dashboard and payout sheets automatically
- **Google Drive Storage**: Secure JSON database storage with backup

## Setup Instructions

### 1. Repository Setup
1. Fork/clone this repository
2. Add required secrets (see Secrets section below)
3. Run the "Initial Historical Data Setup" workflow once

### 2. Required Secrets
Add these to your GitHub repository secrets (Settings → Secrets → Actions):

- `TORN_API_KEY`: Your Torn City API key
- `GOOGLE_SHEETS_ID`: ID of your Google Sheets document
- `GOOGLE_DRIVE_FOLDER_ID`: Google Drive folder ID for JSON storage
- `GOOGLE_DRIVE_CREDENTIALS`: JSON credentials for Google Drive API (see below)

### 3. Google Drive API Setup
1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a new project or select existing
3. Enable Google Drive API and Google Sheets API
4. Create a Service Account
5. Download the JSON credentials file
6. Copy the entire JSON content as the `GOOGLE_DRIVE_CREDENTIALS` secret

### 4. Google Sheets Setup
1. Create a new Google Sheet
2. Share it with your service account email (from credentials JSON)
3. Copy the Sheet ID from the URL
4. Set up the required tabs (see Sheets Structure below)

## Workflows

### Daily Crime Update
- **Schedule**: Runs daily at 6 AM UTC
- **Manual**: Can be triggered from Actions tab
- **Function**: Updates crime database with new data

### CPR Scraper  
- **Trigger**: Button in Google Sheets or manual from Actions tab
- **Function**: Collects member CPR data from available crime slots

### Weekly Payout
- **Trigger**: Manual only with date range inputs
- **Function**: Processes member payments for specified period

### Initial Setup
- **Trigger**: Manual, run once
- **Function**: Populates historical crime data from faction beginning

## File Structure
```
scripts/
├── daily_crime_update.py     # Main crime data updater
├── cpr_scraper.py            # CPR data collection
├── weekly_payout.py          # Payout calculations
├── initial_setup.py          # Historical data setup
├── update_sheet_status.py    # Google Sheets status updates
└── utils/
    ├── google_drive.py       # Drive API functions
    ├── google_sheets.py      # Sheets API functions
    └── torn_api.py           # Torn API wrapper
```

## Usage

1. **Initial Setup**: Run "Initial Historical Data Setup" workflow once
2. **Daily Operations**: Crime data updates automatically
3. **CPR Updates**: Click button in Google Sheets after spawning new crimes
4. **Weekly Payouts**: Run "Weekly Payout Processing" with date range

## Support

Check the Actions tab for workflow run logs and error details. Logs are saved as artifacts for troubleshooting.
