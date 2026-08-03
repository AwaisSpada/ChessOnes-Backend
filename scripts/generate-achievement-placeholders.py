import os

BASES = [
    r"C:\Users\Awais\OneDrive\Desktop\chessones-Flows\chessones-frontend-v2\public\achievements",
    r"C:\dev\chessones-mobile-rn\assets\achievements",
]

KEYS = [
    "bullet_wins_1", "bullet_wins_10", "bullet_wins_50", "bullet_wins_100", "bullet_wins_150",
    "blitz_wins_1", "blitz_wins_10", "blitz_wins_50", "blitz_wins_100", "blitz_wins_150",
    "rapid_wins_1", "rapid_wins_10", "rapid_wins_50", "rapid_wins_100", "rapid_wins_150",
    "wins_total_1", "wins_total_50", "wins_total_100",
    "games_played_10", "games_played_50", "games_played_100",
    "streak_3", "streak_5", "streak_10",
    "rating_bullet_1600", "rating_blitz_1600", "rating_rapid_1600",
    "rating_bullet_1800", "rating_blitz_1800", "rating_rapid_1800",
    "rating_bullet_2000", "rating_blitz_2000", "rating_rapid_2000",
]

COLORS = {
    "bullet": "#F97316",
    "blitz": "#3B82F6",
    "rapid": "#22C55E",
    "wins": "#EAB308",
    "games": "#A855F7",
    "streak": "#EF4444",
    "rating": "#06B6D4",
}


def color_for(key: str) -> str:
    for prefix, color in COLORS.items():
        if key.startswith(prefix):
            return color
    return COLORS["rating"]


def svg_for(key: str) -> str:
    c = color_for(key)
    label = key.replace("_", " ")[:18]
    return f"""<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="{c}"/>
      <stop offset="100%" stop-color="#0f172a"/>
    </linearGradient>
  </defs>
  <rect width="128" height="128" rx="24" fill="url(#g)"/>
  <circle cx="64" cy="52" r="28" fill="rgba(255,255,255,0.18)" stroke="rgba(255,255,255,0.55)" stroke-width="3"/>
  <path d="M64 36 l8 16 h18 l-14 12 6 18-18-12-18 12 6-18-14-12 h18z" fill="#FBBF24"/>
  <text x="64" y="112" text-anchor="middle" font-family="Arial,sans-serif" font-size="10" fill="rgba(255,255,255,0.85)">{label}</text>
</svg>
"""


def main() -> None:
    for base in BASES:
        os.makedirs(base, exist_ok=True)
        for key in KEYS:
            path = os.path.join(base, f"{key}.svg")
            with open(path, "w", encoding="utf-8") as f:
                f.write(svg_for(key))
        print(f"wrote {len(KEYS)} svgs to {base}")


if __name__ == "__main__":
    main()
