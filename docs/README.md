# 🚀 Torn Forge OC Dashboard - Setup Guide

A beautiful, fast, and completely free faction dashboard for Torn City organized crime operations.

## 📸 Features

- **Member Tiers** - View all members sorted by tier with CPR statistics
- **Crime History** - Browse recent crimes with filtering and search
- **Tier Requirements** - See exactly what's needed to reach the next tier
- **Payout Analysis** - Track earnings by member and time period
- **Auto-Updates** - Data refreshes automatically via GitHub Actions
- **Mobile Responsive** - Works perfectly on phones and tablets
- **100% Free** - Hosted on GitHub Pages at no cost

---

## 🎓 Step 1: Get Your GitHub Student Pack (FREE $200+ in credits!)

1. Go to: https://education.github.com/pack
2. Click **"Get your Pack"**
3. Sign in with your GitHub account
4. Verify with your **university email** (.edu address)
5. Upload **proof of enrollment** (student ID or enrollment letter)
6. Wait for approval (usually 1-3 days)

**Benefits for this project:**
- ✅ Free .me domain from Namecheap (optional)
- ✅ $200 DigitalOcean credit (if you need a server later)
- ✅ GitHub Pro features
- ✅ Many other dev tools

---

## 📦 Step 2: Setup Your Dashboard Files

### Option A: Using Git Command Line

```bash
# Navigate to your project
cd /path/to/torn-forge-oc-2.0

# Copy dashboard files to docs folder
mkdir -p docs
cp /path/to/downloaded/docs/* docs/

# Commit and push
git add docs/
git commit -m "Add faction dashboard"
git push origin main
```

### Option B: Using GitHub Web Interface

1. Go to your repository on GitHub
2. Click **"Add file"** → **"Create new file"**
3. Name it: `docs/index.html`
4. Paste the contents from `index.html`
5. Click **"Commit new file"**
6. Repeat for `styles.css` and `dashboard.js`

---

## 🌐 Step 3: Enable GitHub Pages

1. Go to your repo: `https://github.com/YOUR_USERNAME/torn-forge-oc-2.0`
2. Click **Settings** (top right)
3. Scroll to **Pages** (left sidebar under "Code and automation")
4. Under **Source**:
   - Branch: **`main`**
   - Folder: **`/docs`**
   - Click **Save**
5. Wait 1-2 minutes
6. Your dashboard will be live at:
   ```
   https://YOUR_USERNAME.github.io/torn-forge-oc-2.0/
   ```

---

## ⚙️ Step 4: Configure Your Data Sources

You need to tell the dashboard where to find your JSON data.

### Find Your Gist URL

1. Go to: https://gist.github.com/YOUR_USERNAME
2. Find your `cpr_database.json` gist
3. Click **"Raw"** button
4. Copy the URL (should look like):
   ```
   https://gist.githubusercontent.com/YOUR_USERNAME/abc123def456/raw/cpr_database.json
   ```

### Update dashboard.js

Open `docs/dashboard.js` and update the URLs at the top:

```javascript
const CONFIG = {
    // Replace with your actual Gist URL
    cprDataUrl: 'https://gist.githubusercontent.com/YOUR_USERNAME/YOUR_GIST_ID/raw/cpr_database.json',
    
    // Replace with your repo URL
    crimesDataUrl: 'https://raw.githubusercontent.com/YOUR_USERNAME/torn-forge-oc-2.0/main/data/crimes_database.json',
    
    // ... rest of config
};
```

**How to find these:**

**For CPR Data (Gist URL):**
1. Go to your Gist
2. Click the **"Raw"** button
3. Copy the full URL

**For Crimes Data (GitHub Raw URL):**
```
https://raw.githubusercontent.com/YOUR_USERNAME/REPO_NAME/main/data/crimes_database.json
```

### Commit Your Changes

```bash
git add docs/dashboard.js
git commit -m "Configure data sources"
git push origin main
```

Wait 1-2 minutes and refresh your dashboard!

---

## 🎨 Step 5: Customize (Optional)

### Change Colors

Edit `docs/styles.css` and modify the color variables:

```css
:root {
    --primary: #2563eb;      /* Main blue color */
    --secondary: #10b981;     /* Green for success */
    --danger: #ef4444;        /* Red for errors */
    /* ... more colors */
}
```

### Update Header

Edit `docs/index.html` to change the title:

```html
<h1>🔧 Your Faction Name - OC Dashboard</h1>
<p class="subtitle">Your custom subtitle here</p>
```

### Add Your Faction Logo

1. Add image to `docs/images/logo.png`
2. Update header in `index.html`:

```html
<header class="header">
    <img src="images/logo.png" alt="Logo" style="height: 60px;">
    <h1>Your Faction Name</h1>
</header>
```

---

## 🔒 Step 6: Make Data Public (If Using Private Repo)

### Option 1: Use Gist (Recommended)

Your gist updater already handles this! Just make sure your gist is **public**.

1. Go to your Gist
2. Check it's set to **Public** (not Secret)
3. Done! ✅

### Option 2: Make Repository Public

1. Go to **Settings** → **Danger Zone**
2. Click **"Change visibility"**
3. Select **"Make public"**

**Note:** Only do this if you're okay with your crime data being public!

### Option 3: Keep Repo Private, Use Gist Only

This is the best option:
- ✅ Your code stays private
- ✅ Only the JSON data is public (via Gist)
- ✅ Dashboard works perfectly

---

## 🧪 Step 7: Test Your Dashboard

### Basic Functionality Checklist

- [ ] Dashboard loads without errors
- [ ] Member data appears in "Member Tiers" tab
- [ ] Can search and filter members
- [ ] Crime history shows (if you have crimes data)
- [ ] Tier requirements display correctly
- [ ] Stats overview shows correct numbers
- [ ] Mobile responsive (try on phone)

### Debug Mode

Open browser console (F12) and check:

```javascript
// View loaded data
window.dashboard.state

// Reload data manually
await window.dashboard.reloadData()

// Re-render dashboard
window.dashboard.renderDashboard()
```

### Common Issues

**Dashboard shows "Loading..." forever**
- Check browser console for errors
- Verify Gist URL is correct and public
- Make sure JSON files are valid

**Data not updating**
- GitHub Pages can take 1-2 minutes to update
- Try hard refresh: `Ctrl + Shift + R` (or `Cmd + Shift + R` on Mac)
- Check that gist updater is running

**CORS errors**
- Make sure you're using raw URLs (gist.githubusercontent.com or raw.githubusercontent.com)
- Gist must be public
- GitHub Pages must be enabled

---

## 🌟 Step 8: Optional Custom Domain

If you got the free .me domain from Namecheap:

### Configure DNS

1. Log into Namecheap
2. Go to **Domain List** → **Manage**
3. Click **Advanced DNS**
4. Add these records:

```
Type: CNAME
Host: www
Value: YOUR_USERNAME.github.io

Type: A
Host: @
Value: 185.199.108.153

Type: A
Host: @
Value: 185.199.109.153

Type: A
Host: @
Value: 185.199.110.153

Type: A
Host: @
Value: 185.199.111.153
```

### Configure GitHub Pages

1. Go to **Settings** → **Pages**
2. Under **Custom domain**, enter: `yourdomain.me`
3. Check **Enforce HTTPS**
4. Wait 5-10 minutes for DNS to propagate

Your dashboard will be at: `https://yourdomain.me`

---

## 🔄 Automatic Updates

Your dashboard automatically updates when:
- ✅ CPR scraper runs (updates member data)
- ✅ Daily crime logger runs (updates crime data)
- ✅ Gist updater pushes new JSON

**No manual work needed!** Just visit your dashboard URL.

---

## 📊 Data Flow Diagram

```
┌─────────────────────────────────────┐
│  GitHub Actions (Your Scripts)      │
│  • cpr_scraper.py                   │
│  • daily_crime_update.py            │
│  • assign_tiers.py                  │
└──────────────┬──────────────────────┘
               │
               │ Updates every day
               ▼
┌─────────────────────────────────────┐
│  Data Storage                        │
│  • cpr_database.json (in Gist)      │
│  • crimes_database.json (in repo)   │
└──────────────┬──────────────────────┘
               │
               │ Fetched by JavaScript
               ▼
┌─────────────────────────────────────┐
│  GitHub Pages Dashboard              │
│  https://username.github.io/repo/    │
│                                      │
│  • Fetches latest JSON               │
│  • Renders beautiful UI              │
│  • Works on any device               │
└─────────────────────────────────────┘
```

---

## 💡 Pro Tips

### Performance

- ✅ All data loads client-side (no server needed)
- ✅ Gist CDN is fast worldwide
- ✅ Dashboard caches data in browser
- ✅ Perfect for hundreds of members

### Privacy

- 🔒 Main repo can stay **private**
- 🌐 Only JSON data is **public** (via Gist)
- 👥 Members can view their stats
- 🎯 Leadership sees full analytics

### Future Enhancements

You can easily add:
- 📈 Charts with Chart.js or D3.js
- 📱 PWA (install as app)
- 🔔 Notifications for new data
- 📊 Advanced analytics
- 🎮 Torn API integration for live data

---

## 🆘 Troubleshooting

### Dashboard Not Loading

1. Check GitHub Pages is enabled
2. Verify `docs/` folder exists with all files
3. Check browser console for errors (F12)
4. Ensure Gist URLs are correct and public

### No Data Showing

1. Verify Gist URL in `dashboard.js`
2. Check Gist is public (not secret)
3. Confirm JSON files are valid
4. Look for CORS errors in console

### Styles Not Working

1. Ensure `styles.css` is in `docs/` folder
2. Check link tag in `index.html` is correct
3. Hard refresh: `Ctrl + Shift + R`

### Need Help?

1. Check browser console (F12) for errors
2. Verify all URLs are correct
3. Test Gist URL directly in browser
4. Check GitHub Actions are running

---

## 📝 File Structure

```
torn-forge-oc-2.0/
├── docs/                          # GitHub Pages files
│   ├── index.html                # Main dashboard
│   ├── styles.css                # Styling
│   └── dashboard.js              # Data loading & rendering
├── data/                          # Data files (optional for dashboard)
│   ├── cpr_database.json         # Member CPR & tiers
│   └── crimes_database.json      # Crime history
├── scripts/                       # Your existing scripts
│   ├── cpr_scraper.py
│   ├── daily_crime_update.py
│   └── ...
└── README.md
```

---

## 🎉 You're Done!

Your dashboard is now live and will automatically update as your scripts run!

**Your Dashboard URL:**
```
https://YOUR_USERNAME.github.io/torn-forge-oc-2.0/
```

Share this with your faction members and enjoy! 🚀

---

## 📚 Next Steps

- [ ] Test on mobile devices
- [ ] Share URL with faction
- [ ] Customize colors/branding
- [ ] Add custom domain (optional)
- [ ] Monitor GitHub Actions for updates
- [ ] Consider adding more analytics

---

## 🤝 Support

If you run into issues:
1. Check this README
2. Review browser console
3. Verify GitHub Actions are running
4. Check Gist is public and accessible

---

**Made with ❤️ for Torn City factions**
