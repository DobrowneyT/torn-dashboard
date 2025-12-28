import json
import csv

# Input and output file names
INPUT_FILE = "data/crimes_database.json"
OUTPUT_JSON = ".secrets/crime_summary.json"
OUTPUT_CSV = ".secrets/crime_summary.csv"

def main():
    # Load the crime database
    with open(INPUT_FILE, "r") as f:
        data = json.load(f)

    # Ensure the data has a 'crimes' field
    crimes = data.get("crimes", {})
    if not crimes:
        print("❌ No 'crimes' field found in JSON or it's empty.")
        return

    # Structure to hold per-user aggregated stats
    user_stats = {}

    # Iterate through each crime in the database
    for crime_id, crime in crimes.items():
        # Skip crimes that were never executed
        executed_at = crime.get("executed_at")
        if not executed_at:
            continue

        slots = crime.get("slots", [])
        rewards = crime.get("rewards")  # can be None
        is_success = crime.get("status") == "Successful"
        total_slots = crime.get("total_slots", len(slots))

        # Loop through each participant (slot)
        for slot in slots:
            user = slot.get("user")
            if not user:
                continue

            uid = user.get("id")
            joined_at = user.get("joined_at")

            if uid is None or joined_at is None:
                continue

            # Initialize this user if not seen before
            if uid not in user_stats:
                user_stats[uid] = {
                    "id": uid,
                    "crime_count": 0,
                    "successes": 0,
                    "failures": 0,
                    "time_in_crimes": 0,
                    "total_rewards": 0,
                    "pay_per_week": 0
                }

            stats = user_stats[uid]

            # Add to counts
            stats["crime_count"] += 1
            if is_success:
                stats["successes"] += 1
                if rewards:
                    stats["total_rewards"] += ((rewards.get("money", 0)*0.8) / total_slots)
            else:
                stats["failures"] += 1

            # Add time spent (seconds)
            time_spent = executed_at - joined_at
            stats["time_in_crimes"] += time_spent

    # Compute derived values: pay per week
    for uid, stats in user_stats.items():
        time_weeks = stats["time_in_crimes"] / 86400 / 7 if stats["time_in_crimes"] else 0
        stats["pay_per_week"] = stats["total_rewards"] / time_weeks if time_weeks else 0

    # Write JSON output
    with open(OUTPUT_JSON, "w") as f:
        json.dump(user_stats, f, indent=2)

    # Write CSV output
    with open(OUTPUT_CSV, "w", newline="") as f:
        fieldnames = ["id", "crime_count", "successes", "failures", "time_in_crimes", "total_rewards", "pay_per_week"]
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        for row in user_stats.values():
            writer.writerow(row)

    print(f"✅ Done! Wrote {len(user_stats)} user summaries to {OUTPUT_JSON} and {OUTPUT_CSV}")

if __name__ == "__main__":
    main()
