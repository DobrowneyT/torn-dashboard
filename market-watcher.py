"""
Torn Market Sniper Pro - Cross-Platform Edition
Monitors Torn City item market for deals below reference price.
"""

import asyncio
import aiohttp
import numpy as np
import time
import platform
import webbrowser
import threading
import tkinter as tk
from tkinter import ttk
import csv
import os
import json
import logging
from datetime import datetime
from pathlib import Path
from typing import Dict, List, Optional, Tuple


# ─── Configuration ────────────────────────────────────────────────────────────
CONFIG_FILE = Path("sniper_config.json")
LOG_FILE = Path("sniper_log.csv")

DEFAULT_CONFIG = {
    "api_key": "",
    "watched_items": {
        # "206": "Xanax",
        # "367": "Feathery Hotel Coupon",
        # "561": "Book of Carols",
        # "283": "Donator Pack",
        "555": "X-Mass Energy Can",
    },
    "min_profit": 100000,
    "scan_delay": 5,
    "top_check": 5,
    "reference_method": "api_average",  # "api_average", "median_top", or "trimmed_mean"
    "open_browser_on_alert": True,
    "notifications_enabled": True,
    "sound_enabled": True,
}


def load_config() -> dict:
    """Load config from JSON file, creating default if missing."""
    if CONFIG_FILE.exists():
        with open(CONFIG_FILE, "r") as f:
            saved = json.load(f)
        # Merge with defaults so new keys are always present
        merged = {**DEFAULT_CONFIG, **saved}
        return merged
    else:
        save_config(DEFAULT_CONFIG)
        return DEFAULT_CONFIG.copy()


def save_config(config: dict):
    """Persist config to JSON."""
    with open(CONFIG_FILE, "w") as f:
        json.dump(config, f, indent=2)


# ─── Platform Detection ───────────────────────────────────────────────────────
IS_WINDOWS = platform.system() == "Windows"
IS_LINUX = platform.system() == "Linux"

# Optional imports based on platform
if IS_WINDOWS:
    try:
        import winsound
        HAS_WINSOUND = True
    except ImportError:
        HAS_WINSOUND = False
else:
    HAS_WINSOUND = False

# Desktop notifications (cross-platform via plyer)
try:
    from plyer import notification as plyer_notification
    HAS_PLYER = True
except ImportError:
    HAS_PLYER = False

# Linux alternative: notify-send (no dependency needed)
def notify_linux(title: str, message: str, timeout_ms: int = 4000):
    """Send notification via notify-send on Linux."""
    try:
        import subprocess
        subprocess.Popen(
            ["notify-send", "-t", str(timeout_ms), title, message],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
    except FileNotFoundError:
        pass  # notify-send not installed

def send_notification(title: str, message: str):
    """Cross-platform desktop notification."""
    if HAS_PLYER:
        try:
            plyer_notification.notify(title=title, message=message, timeout=4)
            return
        except Exception:
            pass
    if IS_LINUX:
        notify_linux(title, message)

def play_alert_sound():
    """Cross-platform alert beep."""
    if IS_WINDOWS and HAS_WINSOUND:
        winsound.Beep(1600, 300)
    else:
        # Terminal bell — works in most terminals
        print("\a", end="", flush=True)


# ─── Logging ──────────────────────────────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%H:%M:%S",
)
logger = logging.getLogger("sniper")




# ─── Reference Price Strategies ───────────────────────────────────────────────

def ref_api_average(prices: List[int], api_avg: Optional[int]) -> float:
    """
    Use the Torn API's own average_price as reference.
    This is far more meaningful than self-referencing the top-N cheapest.
    Falls back to median if api_avg is unavailable.
    """
    if api_avg and api_avg > 0:
        return float(api_avg)
    return float(np.median(prices))


def ref_median_top(prices: List[int], _api_avg: Optional[int]) -> float:
    """Median of the top-N cheapest listings."""
    return float(np.median(prices))


def ref_trimmed_mean(prices: List[int], _api_avg: Optional[int]) -> float:
    """Trimmed mean — drop lowest and highest, average the rest."""
    if len(prices) <= 2:
        return float(np.mean(prices))
    trimmed = sorted(prices)[1:-1]
    return float(np.mean(trimmed))


REFERENCE_METHODS = {
    "api_average": ref_api_average,
    "median_top": ref_median_top,
    "trimmed_mean": ref_trimmed_mean,
}


# ─── CSV Logger ───────────────────────────────────────────────────────────────

def init_csv_log():
    """Create CSV with headers if it doesn't exist."""
    if not LOG_FILE.exists():
        with open(LOG_FILE, "w", newline="") as f:
            writer = csv.writer(f)
            writer.writerow(["timestamp", "item_name", "item_id", "price", "reference", "profit", "amount_available"])


def log_deal(item_name: str, item_id: int, price: int, ref: float, profit: float, amount: int):
    """Append deal to CSV log."""
    with open(LOG_FILE, "a", newline="") as f:
        writer = csv.writer(f)
        writer.writerow([
            datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
            item_name,
            item_id,
            price,
            int(ref),
            int(profit),
            amount,
        ])


# ─── Core Sniper Logic ───────────────────────────────────────────────────────

class MarketSniper:
    """Async market scanner with deal detection."""

    def __init__(self, config: dict, gui_callback=None):
        self.config = config
        self.gui_callback = gui_callback  # function(event_type, data)
        self.running = False
        self.total_profit = 0
        self.deal_count = 0
        self.scan_count = 0
        # Track alerted listings to avoid duplicate alerts within a scan cycle
        self._alerted_prices: Dict[int, set] = {}  # item_id -> set of prices already alerted

    async def fetch_market(self, session: aiohttp.ClientSession, item_id: int) -> Optional[dict]:
        """Fetch item market data from Torn API v2."""
        url = f"https://api.torn.com/v2/market/{item_id}/itemmarket"
        params = {
            "key": self.config["api_key"],
            "comment": "Market_Sniper",
        }
        try:
            async with session.get(url, params=params, timeout=aiohttp.ClientTimeout(total=15)) as resp:
                if resp.status != 200:
                    logger.warning(f"HTTP {resp.status} for item {item_id}")
                    return None
                data = await resp.json()

                if "error" in data:
                    logger.error(f"API error for item {item_id}: {data['error']}")
                    return None

                return data
        except asyncio.TimeoutError:
            logger.warning(f"Timeout fetching item {item_id}")
            return None
        except Exception as e:
            logger.error(f"Error fetching item {item_id}: {e}")
            return None

    def evaluate_listings(self, item_id: int, data: dict) -> List[dict]:
        """
        Parse API response and find deals.

        Expected response structure:
        {
          "itemmarket": {
            "item": {"id": 206, "name": "Xanax", "type": "Drug", "average_price": 822880},
            "listings": [
              {"price": 843000, "amount": 26},
              {"price": 843500, "amount": 8},
              ...
            ]
          }
        }

        Listings come pre-sorted by price ascending from the API.
        """
        deals = []

        try:
            itemmarket = data.get("itemmarket", {})
            item_meta = itemmarket.get("item", {})
            listings = itemmarket.get("listings", [])

            if not listings:
                return deals

            api_avg = item_meta.get("average_price")
            item_name = self.config["watched_items"].get(str(item_id), f"Item #{item_id}")

            # Grab top N listings (already sorted by API)
            top_n = self.config.get("top_check", 5)
            top_listings = listings[:top_n]
            prices = [entry["price"] for entry in top_listings]

            # Calculate reference price
            method_name = self.config.get("reference_method", "api_average")
            ref_func = REFERENCE_METHODS.get(method_name, ref_api_average)
            ref = ref_func(prices, api_avg)

            min_profit = self.config.get("min_profit", 100000)

            for entry in top_listings:
                price = entry["price"]
                amount = entry.get("amount", 1)
                profit = ref - price

                if profit >= min_profit:
                    # Skip if we already alerted this exact price for this item
                    alerted = self._alerted_prices.setdefault(item_id, set())
                    if price in alerted:
                        continue
                    alerted.add(price)

                    deals.append({
                        "item_id": item_id,
                        "item_name": item_name,
                        "price": price,
                        "amount": amount,
                        "reference": ref,
                        "profit": profit,
                        "api_average": api_avg,
                    })

        except (KeyError, TypeError, IndexError) as e:
            logger.error(f"Error parsing item {item_id}: {e}")

        return deals

    def handle_deal(self, deal: dict):
        """Process a detected deal — alert, log, open browser."""
        self.total_profit += deal["profit"]
        self.deal_count += 1

        item_name = deal["item_name"]
        price = deal["price"]
        ref = deal["reference"]
        profit = deal["profit"]
        item_id = deal["item_id"]
        amount = deal["amount"]

        logger.info(
            f"🔥 DEAL: {item_name} — ${price:,} (ref ${ref:,.0f}) — "
            f"profit ${profit:,.0f} — qty {amount}"
        )

        # Log to CSV
        log_deal(item_name, item_id, price, ref, profit, amount)

        # Desktop notification
        if self.config.get("notifications_enabled", True):
            send_notification(
                "🔥 Torn Deal Alert",
                f"{item_name}\n${price:,} (save ${profit:,.0f})\nQty: {amount}",
            )

        # Sound
        if self.config.get("sound_enabled", True):
            play_alert_sound()

        # Open browser
        if self.config.get("open_browser_on_alert", True):
            url = f"https://www.torn.com/page.php?sid=ItemMarket#/market/view=search&itemID={item_id}"
            webbrowser.open_new_tab(url)

        # Notify GUI
        if self.gui_callback:
            self.gui_callback("deal", deal)

    async def run(self):
        """Main scan loop."""
        self.running = True
        init_csv_log()

        connector = aiohttp.TCPConnector(limit=20)
        async with aiohttp.ClientSession(connector=connector) as session:
            while self.running:
                start = time.monotonic()
                self.scan_count += 1

                item_ids = [int(k) for k in self.config["watched_items"].keys()]
                tasks = [self.fetch_market(session, iid) for iid in item_ids]
                results = await asyncio.gather(*tasks)

                total_deals = 0
                for item_id, data in zip(item_ids, results):
                    if data is None:
                        continue
                    deals = self.evaluate_listings(item_id, data)
                    for deal in deals:
                        self.handle_deal(deal)
                        total_deals += 1

                elapsed = time.monotonic() - start
                scan_delay = self.config.get("scan_delay", 5)

                # Notify GUI of scan completion
                if self.gui_callback:
                    self.gui_callback("scan", {
                        "scan_count": self.scan_count,
                        "elapsed": elapsed,
                        "deals_this_scan": total_deals,
                        "total_profit": self.total_profit,
                        "deal_count": self.deal_count,
                    })

                logger.debug(f"Scan #{self.scan_count} done in {elapsed:.2f}s — {total_deals} deals")

                sleep_time = max(0, scan_delay - elapsed)
                # Sleep in small chunks so we can stop quickly
                slept = 0.0
                while slept < sleep_time and self.running:
                    await asyncio.sleep(min(0.5, sleep_time - slept))
                    slept += 0.5

        # Clear alerted set when stopping
        self._alerted_prices.clear()

    def stop(self):
        """Signal the scan loop to stop."""
        self.running = False


# ─── GUI ──────────────────────────────────────────────────────────────────────

class SniperGUI:
    """Tkinter GUI for the market sniper."""

    def __init__(self):
        self.config = load_config()
        self.sniper: Optional[MarketSniper] = None
        self.thread: Optional[threading.Thread] = None

        self._build_window()

    def _build_window(self):
        self.root = tk.Tk()
        self.root.title("Torn Market Sniper Pro")
        self.root.geometry("460x480")
        self.root.resizable(False, False)
        self.root.configure(bg="#1e1e2e")

        style = ttk.Style(self.root)
        style.theme_use("clam")

        # Color palette
        bg = "#1e1e2e"
        fg = "#cdd6f4"
        accent = "#89b4fa"
        surface = "#313244"
        red = "#f38ba8"
        green = "#a6e3a1"

        style.configure("TLabel", background=bg, foreground=fg, font=("Segoe UI", 10))
        style.configure("TButton", background=surface, foreground=fg, font=("Segoe UI", 10, "bold"))
        style.map("TButton", background=[("active", accent)])
        style.configure("TEntry", fieldbackground=surface, foreground=fg, font=("Segoe UI", 10))
        style.configure("Header.TLabel", font=("Segoe UI", 14, "bold"), foreground=accent, background=bg)
        style.configure("Status.TLabel", font=("Segoe UI", 11, "bold"), background=bg)
        style.configure("Profit.TLabel", font=("Segoe UI", 11), foreground=green, background=bg)

        # Header
        ttk.Label(self.root, text="Torn Market Sniper", style="Header.TLabel").pack(pady=(12, 4))

        # ── API Key ──
        frame_api = tk.Frame(self.root, bg=bg)
        frame_api.pack(fill="x", padx=20, pady=4)
        ttk.Label(frame_api, text="API Key:").pack(side="left")
        self.api_key_var = tk.StringVar(value=self.config.get("api_key", ""))
        api_entry = ttk.Entry(frame_api, textvariable=self.api_key_var, show="*", width=32)
        api_entry.pack(side="left", padx=(8, 0))

        # ── Min Profit ──
        frame_profit = tk.Frame(self.root, bg=bg)
        frame_profit.pack(fill="x", padx=20, pady=4)
        ttk.Label(frame_profit, text="Min Profit ($):").pack(side="left")
        self.min_profit_var = tk.StringVar(value=str(self.config.get("min_profit", 100000)))
        ttk.Entry(frame_profit, textvariable=self.min_profit_var, width=14).pack(side="left", padx=(8, 0))

        # ── Scan Delay ──
        frame_delay = tk.Frame(self.root, bg=bg)
        frame_delay.pack(fill="x", padx=20, pady=4)
        ttk.Label(frame_delay, text="Scan Delay (s):").pack(side="left")
        self.scan_delay_var = tk.IntVar(value=self.config.get("scan_delay", 5))
        self.delay_label = ttk.Label(frame_delay, text=f"{self.scan_delay_var.get()}s")
        scale = ttk.Scale(
            frame_delay, from_=2, to=30, orient="horizontal",
            variable=self.scan_delay_var, length=160,
            command=lambda _: self.delay_label.config(text=f"{self.scan_delay_var.get()}s"),
        )
        scale.pack(side="left", padx=(8, 4))
        self.delay_label.pack(side="left")

        # ── Reference Method ──
        frame_ref = tk.Frame(self.root, bg=bg)
        frame_ref.pack(fill="x", padx=20, pady=4)
        ttk.Label(frame_ref, text="Reference:").pack(side="left")
        self.ref_method_var = tk.StringVar(value=self.config.get("reference_method", "api_average"))
        ref_menu = ttk.Combobox(
            frame_ref, textvariable=self.ref_method_var, width=16, state="readonly",
            values=["api_average", "median_top", "trimmed_mean"],
        )
        ref_menu.pack(side="left", padx=(8, 0))

        # ── Toggles ──
        frame_toggles = tk.Frame(self.root, bg=bg)
        frame_toggles.pack(fill="x", padx=20, pady=4)
        self.browser_var = tk.BooleanVar(value=self.config.get("open_browser_on_alert", True))
        self.notify_var = tk.BooleanVar(value=self.config.get("notifications_enabled", True))
        self.sound_var = tk.BooleanVar(value=self.config.get("sound_enabled", True))
        tk.Checkbutton(frame_toggles, text="Open browser", variable=self.browser_var,
                       bg=bg, fg=fg, selectcolor=surface, activebackground=bg, activeforeground=fg).pack(side="left")
        tk.Checkbutton(frame_toggles, text="Notifications", variable=self.notify_var,
                       bg=bg, fg=fg, selectcolor=surface, activebackground=bg, activeforeground=fg).pack(side="left", padx=8)
        tk.Checkbutton(frame_toggles, text="Sound", variable=self.sound_var,
                       bg=bg, fg=fg, selectcolor=surface, activebackground=bg, activeforeground=fg).pack(side="left")

        # ── Buttons ──
        frame_btns = tk.Frame(self.root, bg=bg)
        frame_btns.pack(fill="x", padx=20, pady=8)
        self.start_btn = ttk.Button(frame_btns, text="▶  Start", command=self.start, width=14)
        self.start_btn.pack(side="left", padx=(0, 8))
        self.stop_btn = ttk.Button(frame_btns, text="⏸  Pause", command=self.stop, width=14)
        self.stop_btn.pack(side="left")

        # ── Status ──
        self.status_label = ttk.Label(self.root, text="Status: IDLE", style="Status.TLabel", foreground=red)
        self.status_label.pack(pady=(6, 2))

        self.profit_label = ttk.Label(
            self.root,
            text="Profit: $0  |  Deals: 0  |  Scans: 0",
            style="Profit.TLabel",
        )
        self.profit_label.pack(pady=2)

        self.last_scan_label = ttk.Label(self.root, text="")
        self.last_scan_label.pack(pady=2)

        # ── Watched Items Display ──
        items_text = ", ".join(f"{v}" for v in self.config["watched_items"].values())
        ttk.Label(self.root, text=f"Watching: {items_text}", wraplength=420).pack(pady=(8, 2))

        platform_info = f"Platform: {platform.system()} {platform.release()}"
        ttk.Label(self.root, text=platform_info, font=("Segoe UI", 8)).pack(pady=(2, 4))

        # ── Keyboard shortcut (cross-platform via tkinter binding) ──
        self.root.bind("<F8>", lambda _: self.toggle())
        ttk.Label(self.root, text="F8 = Toggle Start/Pause", font=("Segoe UI", 8)).pack()

        self.root.protocol("WM_DELETE_WINDOW", self._on_close)

    # ── Actions ──

    def _sync_config(self):
        """Pull current GUI values into config dict."""
        try:
            self.config["min_profit"] = int(self.min_profit_var.get())
        except ValueError:
            self.config["min_profit"] = 100000

        self.config["api_key"] = self.api_key_var.get().strip()
        self.config["scan_delay"] = self.scan_delay_var.get()
        self.config["reference_method"] = self.ref_method_var.get()
        self.config["open_browser_on_alert"] = self.browser_var.get()
        self.config["notifications_enabled"] = self.notify_var.get()
        self.config["sound_enabled"] = self.sound_var.get()
        save_config(self.config)

    def start(self):
        self._sync_config()

        if not self.config["api_key"]:
            self.status_label.config(text="Status: NO API KEY", foreground="#f38ba8")
            return

        if self.sniper and self.sniper.running:
            return

        self.sniper = MarketSniper(self.config, gui_callback=self._gui_event)
        self.thread = threading.Thread(target=self._run_loop, daemon=True)
        self.thread.start()
        self.status_label.config(text="Status: RUNNING", foreground="#a6e3a1")

    def stop(self):
        if self.sniper:
            self.sniper.stop()
        self.status_label.config(text="Status: PAUSED", foreground="#f38ba8")

    def toggle(self):
        if self.sniper and self.sniper.running:
            self.stop()
        else:
            self.start()

    def _run_loop(self):
        asyncio.run(self.sniper.run())

    def _gui_event(self, event_type: str, data: dict):
        """
        Called from the async thread — schedule GUI update on the main thread.
        This is critical for thread safety with tkinter.
        """
        self.root.after(0, self._process_event, event_type, data)

    def _process_event(self, event_type: str, data: dict):
        if event_type == "scan":
            self.profit_label.config(
                text=(
                    f"Profit: ${data['total_profit']:,.0f}  |  "
                    f"Deals: {data['deal_count']}  |  "
                    f"Scans: {data['scan_count']}"
                )
            )
            self.last_scan_label.config(
                text=f"Last scan: {data['elapsed']:.2f}s — {data['deals_this_scan']} deal(s)"
            )
        elif event_type == "deal":
            # Could add a deal list widget here in the future
            pass

    def _on_close(self):
        self.stop()
        self._sync_config()
        self.root.destroy()

    def run(self):
        self.root.mainloop()


# ─── Entry Point ──────────────────────────────────────────────────────────────

if __name__ == "__main__":
    app = SniperGUI()
    app.run()