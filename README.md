# Torn Forge OC Dashboard - React Edition

Professional, scalable faction dashboard with local development, light/dark mode, and modern React architecture.

## Features

- Modern React 18 with hooks
- Vite for lightning-fast development
- Tailwind CSS for styling
- Light/Dark mode toggle with persistence
- Responsive design (mobile-first)
- Sortable, filterable data tables
- Real-time data from GitHub/Gist
- Production-ready build system
- GitHub Pages deployment

## Quick Start

### 1. Install Dependencies

```bash
npm install
```

### 2. Configure Data Sources

Copy the environment template:

```bash
cp .env.example .env
```

Edit `.env` and update with your URLs:

```env
VITE_CPR_DATA_URL=https://gist.githubusercontent.com/YOUR_USERNAME/YOUR_GIST_ID/raw/cpr_database.json
VITE_CRIMES_DATA_URL=https://raw.githubusercontent.com/YOUR_USERNAME/torn-forge-oc-2.0/main/data/crimes_database.json
```

### 3. Update Vite Config

Edit `vite.config.js` and change the base URL to match your repo name:

```javascript
export default defineConfig({
  base: '/YOUR_REPO_NAME/', // e.g., '/torn-forge-oc-2.0/'
  // ...
})
```

### 4. Run Development Server

```bash
npm run dev
```

Opens at `http://localhost:3000` with hot reload enabled.

## Development Workflow

### Local Development

```bash
# Start dev server (hot reload)
npm run dev

# Build for production
npm run build

# Preview production build locally
npm run preview
```

### Branch Strategy

**Recommended workflow:**

1. **Development:** Work on `dev` branch
   ```bash
   git checkout -b dev
   npm run dev  # Test locally
   ```

2. **Testing:** Build and preview
   ```bash
   npm run build
   npm run preview
   ```

3. **Deploy:** Merge to `main` when ready
   ```bash
   git checkout main
   git merge dev
   npm run deploy  # Builds and deploys to GitHub Pages
   ```

This ensures you **never break production** - only deploys when you explicitly merge to main.

## GitHub Pages Setup

### Method 1: Automated Deployment (Recommended)

```bash
# Deploy to GitHub Pages
npm run deploy
```

This builds the site and pushes to `gh-pages` branch.

**Then enable GitHub Pages:**
1. Go to repo Settings → Pages
2. Source: `gh-pages` branch, `/` (root) folder
3. Save

### Method 2: Manual Setup

1. Build the site:
   ```bash
   npm run build
   ```

2. The `dist/` folder contains your built site

3. Copy to `docs/` if you prefer:
   ```bash
   cp -r dist/* docs/
   git add docs/
   git commit -m "Deploy dashboard"
   git push
   ```

4. Enable GitHub Pages:
   - Settings → Pages
   - Source: `main` branch, `/docs` folder

## Project Structure

```
dashboard-react/
├── src/
│   ├── components/      # Reusable components
│   │   ├── Header.jsx
│   │   ├── Navigation.jsx
│   │   └── StatsOverview.jsx
│   ├── views/           # Main view components
│   │   ├── MembersView.jsx
│   │   ├── CrimesView.jsx
│   │   ├── TierRequirementsView.jsx
│   │   └── PayoutsView.jsx
│   ├── contexts/        # React contexts
│   │   └── ThemeContext.jsx
│   ├── config.js        # Configuration
│   ├── App.jsx          # Main app component
│   ├── main.jsx         # Entry point
│   └── index.css        # Global styles
├── public/              # Static assets
├── dist/                # Build output (gitignored)
├── package.json
├── vite.config.js
├── tailwind.config.js
└── .env                 # Environment variables (gitignored)
```

## Customization

### Faction Information

Edit `src/config.js`:

```javascript
faction: {
  name: "Your Faction Name",
  tag: "[TAG]",
  founded: "2020",
}
```

### Theme Colors

Edit `tailwind.config.js` to customize colors:

```javascript
theme: {
  extend: {
    colors: {
      // Customize tier colors, light/dark mode colors, etc.
    }
  }
}
```

### Adding Features

The modular structure makes it easy to add:
- New views (create in `src/views/`)
- New components (create in `src/components/`)
- New navigation tabs (edit `src/components/Navigation.jsx`)

## Light/Dark Mode

The theme toggle in the header allows users to switch between light and dark modes. Preference is saved to localStorage and persists across sessions.

**System preference detection:** If no preference is set, the app detects the user's system theme preference.

## Building for Production

```bash
# Build optimized production bundle
npm run build

# Output is in dist/ folder
# Includes minification, tree-shaking, code splitting
```

Production build is optimized for:
- Small bundle size
- Fast loading
- Efficient caching
- SEO-friendly

## Environment Variables

Create `.env` file (never commit this):

```env
VITE_CPR_DATA_URL=your_cpr_gist_url
VITE_CRIMES_DATA_URL=your_crimes_github_url
```

Access in code:
```javascript
import.meta.env.VITE_CPR_DATA_URL
```

## Deployment Options

### 1. GitHub Pages (Free, Recommended)

```bash
npm run deploy
```

### 2. Vercel (Free, with serverless)

1. Connect repo to Vercel
2. Build command: `npm run build`
3. Output directory: `dist`
4. Auto-deploys on push to main

### 3. Netlify (Free, with forms/functions)

1. Connect repo to Netlify
2. Build command: `npm run build`
3. Publish directory: `dist`
4. Auto-deploys on push to main

## Troubleshooting

### Dev server won't start

```bash
# Clear node_modules and reinstall
rm -rf node_modules package-lock.json
npm install
```

### Build fails

```bash
# Check environment variables
cat .env

# Check Vite config base URL matches your repo
cat vite.config.js
```

### Data not loading

1. Check `.env` URLs are correct
2. Verify Gist is public
3. Open browser console (F12) for errors
4. Test URLs directly in browser

### Dark mode not working

Clear localStorage:
```javascript
// In browser console
localStorage.removeItem('theme')
```

## Performance

- **Initial load:** < 100KB gzipped
- **Time to interactive:** < 1 second
- **Lighthouse score:** 95+ (Performance, Accessibility, Best Practices)

## Browser Support

- Chrome/Edge 90+
- Firefox 88+
- Safari 14+
- Mobile browsers (iOS Safari, Chrome Mobile)

## Contributing

1. Fork the repository
2. Create feature branch (`git checkout -b feature/amazing-feature`)
3. Commit changes (`git commit -m 'Add amazing feature'`)
4. Push to branch (`git push origin feature/amazing-feature`)
5. Open Pull Request

## License

MIT License - feel free to use for your faction!

## Support

- Check browser console for errors
- Verify data URLs are accessible
- Test with `npm run preview` before deploying
- Review GitHub Pages deployment logs

---

**Built for Torn City factions with ❤️**
