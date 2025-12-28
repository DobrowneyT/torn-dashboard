import csv
import json

def parse_money(value):
    """Convert a money string like '$100,000' into an int."""
    if not value:
        return 0
    return int(value.replace('$', '').replace(',', '').strip())

def main():
    input_csv = "PA_log.csv"
    output_json = ".secrets/PA_Payouts.json"
    output_csv = ".secrets/PA_Payouts.csv"

    user_data = {}

    with open(input_csv, newline='', encoding='utf-8') as f:
        reader = csv.DictReader(f)
        for row in reader:
            # Only analyze Political Assassination crimes
            if row.get("Type") != "Political Assassination":
                continue

            # Skip rows missing money or result
            money = parse_money(row.get("Money", "0"))
            result = row.get("Result", "").strip()

            # Determine success/failure
            is_success = result.lower() == "pass"

            # Collect all member IDs (columns Member1–Member15)
            member_ids = [row.get(f"Member{i}") for i in range(1, 5)]
            member_ids = [m for m in member_ids if m and m.strip() != ""]

            # For each user, update totals
            for user_id in member_ids:
                if user_id not in user_data:
                    user_data[user_id] = {
                        "user_id": user_id,
                        "total_pa": 0,
                        "successful_pa": 0,
                        "failed_pa": 0,
                        "total_money": 0
                    }

                user = user_data[user_id]
                user["total_pa"] += 1
                user["total_money"] += money

                if is_success:
                    user["successful_pa"] += 1
                else:
                    user["failed_pa"] += 1

    # Save JSON output
    with open(output_json, "w", encoding="utf-8") as jf:
        json.dump(user_data, jf, indent=4)

    # Save CSV output
    with open(output_csv, "w", newline='', encoding="utf-8") as cf:
        fieldnames = ["user_id", "total_pa", "successful_pa", "failed_pa", "total_money"]
        writer = csv.DictWriter(cf, fieldnames=fieldnames)
        writer.writeheader()
        for user in user_data.values():
            writer.writerow(user)

    print(f"✅ Processed {len(user_data)} users.")
    print(f"Saved to {output_json} and {output_csv}")

if __name__ == "__main__":
    main()
