export default {
  content: ["./index.html", "./src/**/*.{js,jsx}"],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        // ⚠️ The site accent. Every `blue-*` class reads these variables, which
        // default to Tailwind's own blues (index.css) and are overridden with
        // the event colour while a live event allows it (utils/siteAccent.js).
        blue: Object.fromEntries([50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950]
          .map((k) => [k, `rgb(var(--accent-${k}) / <alpha-value>)`])),
        tier: {
          1: '#ef4444', 2: '#f59e0b', 3: '#eab308',
          4: '#22c55e', 5: '#3b82f6', 6: '#6366f1',
        },
      },
    },
  },
  plugins: [],
}