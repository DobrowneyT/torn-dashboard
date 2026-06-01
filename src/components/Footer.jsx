export default function Footer() {
  const version = import.meta.env.VITE_APP_VERSION || '1.0.0'

  return (
    <footer className="mt-auto border-t border-gray-200 dark:border-slate-700 bg-white dark:bg-slate-800">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-4">
        <p className="text-center text-xs text-gray-400 dark:text-gray-500">
          Designed by{' '}
          <a
            href="https://www.torn.com/profiles.php?XID=2250591"
            target="_blank"
            rel="noreferrer"
            className="hover:text-gray-300 dark:hover:text-gray-300 underline underline-offset-2"
          >
            MonChoon
          </a>
          &nbsp;·&nbsp; Copyright © 2026 &nbsp;·&nbsp; Version {version}
        </p>
      </div>
    </footer>
  )
}
