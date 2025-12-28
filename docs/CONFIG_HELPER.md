# 🔧 Dashboard Configuration Helper

## Finding Your Data URLs

You need two URLs to configure your dashboard:

### 1️⃣ CPR Data URL (from GitHub Gist)

**Where it is:** Your public Gist containing `cpr_database.json`

**How to find it:**

1. Go to your Gists: `https://gist.github.com/YOUR_USERNAME`
2. Find the Gist with `cpr_database.json`
3. Click on the Gist title to open it
4. Click the **"Raw"** button (top right of the file)
5. Copy the full URL from your browser address bar

**It should look like:**
```
https://gist.githubusercontent.com/YOUR_USERNAME/abc123def456/raw/cpr_database.json
```

**Example:**
```
https://gist.githubusercontent.com/johndoe/7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c/raw/cpr_database.json
```

---

### 2️⃣ Crimes Data URL (from GitHub Repository)

**Where it is:** Your GitHub repository's `data/crimes_database.json` file

**How to construct it:**

```
https://raw.githubusercontent.com/YOUR_USERNAME/REPO_NAME/main/data/crimes_database.json
```

**Replace:**
- `YOUR_USERNAME` with your GitHub username
- `REPO_NAME` with your repository name (probably `torn-forge-oc-2.0`)

**Example:**
```
https://raw.githubusercontent.com/johndoe/torn-forge-oc-2.0/main/data/crimes_database.json
```

---

## Updating dashboard.js

Once you have both URLs, open `docs/dashboard.js` and update this section:

```javascript
const CONFIG = {
    // CHANGE THESE TO YOUR ACTUAL URLs
    cprDataUrl: 'PASTE_YOUR_GIST_URL_HERE',
    crimesDataUrl: 'PASTE_YOUR_GITHUB_RAW_URL_HERE',
    
    // ... rest stays the same
};
```

### ✅ Complete Example

```javascript
const CONFIG = {
    cprDataUrl: 'https://gist.githubusercontent.com/johndoe/7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c/raw/cpr_database.json',
    crimesDataUrl: 'https://raw.githubusercontent.com/johndoe/torn-forge-oc-2.0/main/data/crimes_database.json',
    
    // Tier requirements (from your tier assignment script)
    tierRequirements: {
        // ... (don't change this part)
    }
};
```

---

## Quick Verification

### Test Your URLs

**1. Test Gist URL in browser:**
- Open your Gist URL in a new browser tab
- You should see raw JSON data
- If you get a 404 or access denied, the Gist might be private

**2. Test GitHub Raw URL in browser:**
- Open your GitHub Raw URL in a new browser tab
- You should see raw JSON data
- If you get a 404, check the file path is correct

### Common Issues

**Gist URL shows "Not Found"**
- ❌ Gist is set to "Secret" instead of "Public"
- ✅ Go to Gist → Click "..." → Make public

**GitHub Raw URL shows "Not Found"**
- ❌ File path is wrong
- ✅ Check that file exists at `data/crimes_database.json`
- ✅ Branch name is correct (`main` not `master`)

**CORS errors in browser console**
- ❌ Using wrong URL format
- ✅ Must use `gist.githubusercontent.com` or `raw.githubusercontent.com`
- ✅ NOT `gist.github.com` or `github.com`

---

## Alternative: Using Only Gist

If you want to keep your repository private but still have a public dashboard, you can publish both JSON files to Gist:

### Setup

1. Create a **public** Gist with both files:
   - `cpr_database.json`
   - `crimes_database.json`

2. Get the Raw URLs for both files

3. Update `dashboard.js`:

```javascript
const CONFIG = {
    cprDataUrl: 'https://gist.githubusercontent.com/USERNAME/GIST_ID/raw/cpr_database.json',
    crimesDataUrl: 'https://gist.githubusercontent.com/USERNAME/GIST_ID/raw/crimes_database.json',
    // ...
};
```

This way:
- ✅ Your code stays private
- ✅ Only JSON data is public
- ✅ Dashboard works perfectly

---

## Testing Your Configuration

After updating `dashboard.js`, you can test locally:

### Option 1: Python HTTP Server

```bash
cd docs/
python3 -m http.server 8000
```

Open: `http://localhost:8000`

### Option 2: VS Code Live Server

1. Install "Live Server" extension
2. Right-click `index.html`
3. Select "Open with Live Server"

### What to Check

- [ ] Dashboard loads without errors
- [ ] Open browser console (F12)
- [ ] Check for any red error messages
- [ ] Verify data appears in tables
- [ ] Check network tab shows successful requests

---

## Environment Variables Alternative

For advanced users, you can use environment variables in your build process:

```javascript
const CONFIG = {
    cprDataUrl: process.env.CPR_DATA_URL || 'fallback_url',
    crimesDataUrl: process.env.CRIMES_DATA_URL || 'fallback_url',
    // ...
};
```

Then set GitHub Secrets and use a build step to inject them.

---

## Final Checklist

Before committing:

- [ ] Both URLs are correct
- [ ] Gist is **public** (not secret)
- [ ] URLs tested in browser (show JSON)
- [ ] Dashboard tested locally
- [ ] No errors in browser console
- [ ] Data appears correctly

---

## Need Help?

1. **URLs not working?**
   - Make sure Gist is public
   - Verify file names are correct
   - Check URLs in browser directly

2. **Dashboard not loading data?**
   - Open browser console (F12)
   - Look for CORS or network errors
   - Verify URLs are in correct format

3. **Still stuck?**
   - Double-check this guide
   - Review the main README.md
   - Check GitHub Pages is enabled

---

**Pro Tip:** Keep your URLs somewhere safe! You might need them if you ever recreate the dashboard or want to add more features.
