export default {
  content: ["./index.html", "./src/**/*.{js,jsx}"],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        tier: {
          1: '#ef4444', 2: '#f59e0b', 3: '#eab308',
          4: '#22c55e', 5: '#3b82f6', 6: '#6366f1',
        },
      },
    },
  },
  plugins: [],
}