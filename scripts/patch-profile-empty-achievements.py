from pathlib import Path

path = Path(
    r"C:\Users\Awais\OneDrive\Desktop\chessones-Flows\chessones-frontend-v2\app\profile\page.tsx"
)
text = path.read_text(encoding="utf-8")
marker_start = (
    '                <div className="glass-card rounded-2xl sm:rounded-3xl p-4 sm:p-8 max-w-full">\n'
    '                  <div className="mb-4 flex items-center justify-between gap-3">\n'
    '                    <h2 className="text-lg sm:text-xl font-heading font-black flex items-center gap-3 text-white">\n'
    '                      <Award className="w-5 h-5 text-amber-gold shrink-0" />\n'
    "                      Achievements"
)
marker_end = "              {/* Game History Table"
start = text.find(marker_start)
end = text.find(marker_end, start)
if start < 0 or end < 0:
    raise SystemExit(f"markers not found start={start} end={end}")

new = r'''                <div className="glass-card rounded-2xl sm:rounded-3xl p-4 sm:p-8 max-w-full">
                  <div className="mb-4 flex items-center justify-between gap-3">
                    <h2 className="text-lg sm:text-xl font-heading font-black flex items-center gap-3 text-white">
                      <Award className="w-5 h-5 text-amber-gold shrink-0" />
                      Achievements
                    </h2>
                    {achievements.some((a) => a.unlocked) ? (
                      <button
                        type="button"
                        className="text-sm font-bold text-electric-blue hover:text-white transition-colors"
                        onClick={() => {
                          const qs = profileUserId
                            ? `?userId=${encodeURIComponent(profileUserId)}`
                            : "";
                          router.push(`/achievements${qs}`);
                        }}
                      >
                        View all →
                      </button>
                    ) : null}
                  </div>
                  {(() => {
                    const preview = achievements.filter((a) => a.unlocked).slice(0, 6);
                    if (preview.length === 0) {
                      return (
                        <p className="text-sm text-gray-500">No achievements yet</p>
                      );
                    }
                    return (
                      <>
                        <div className="grid grid-cols-3 gap-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6">
                          {preview.map((a) => (
                            <div
                              key={a.id}
                              className="group relative flex flex-col items-center gap-2"
                              title={`${a.name}: ${a.description}`}
                            >
                              <div className="relative h-20 w-20 overflow-hidden rounded-2xl bg-[#0B1220] sm:h-24 sm:w-24">
                                {a.imageUrl ? (
                                  <img
                                    src={a.imageUrl}
                                    alt={a.name}
                                    className="h-full w-full object-contain p-2"
                                  />
                                ) : (
                                  <div className="flex h-full w-full items-center justify-center bg-white/5">
                                    <Award className="h-8 w-8 text-amber-gold" />
                                  </div>
                                )}
                                {a.pill ? (
                                  <span className="absolute bottom-1.5 right-1.5 rounded-full bg-violet-300 px-1.5 py-0.5 text-[10px] font-black text-[#0B1020]">
                                    {a.pill}
                                  </span>
                                ) : null}
                              </div>
                              <span className="line-clamp-2 text-center text-[10px] font-bold text-gray-200">
                                {a.name}
                              </span>
                            </div>
                          ))}
                        </div>
                        <p className="mt-3 text-xs text-gray-500">
                          Unlocked {achievementSummary.unlocked} / {achievementSummary.total}
                        </p>
                      </>
                    );
                  })()}
                </div>
              </div>

'''

path.write_text(text[:start] + new + text[end:], encoding="utf-8")
print("ok")
