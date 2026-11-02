import type { Difficulty } from "./api/client";

const METERS = [
  ["Prep", "prep"],
  ["Cook", "cook"],
  ["Cleanup", "cleanup"],
] as const;

// A recipe's Difficulty: a meter of three pips each for Prep, Cook and Cleanup, then the Total
// Difficulty out of 9. Screen readers hear it as one sentence. Nothing shows for a recipe without
// one. A Suggested Difficulty says so beside the Total, and in that sentence.
export function DifficultyMeters({
  difficulty,
  suggested = false,
}: {
  difficulty: Difficulty | null;
  suggested?: boolean;
}) {
  if (!difficulty) return null;
  const total = difficulty.prep + difficulty.cook + difficulty.cleanup;
  const spoken = METERS.map(([label, key]) => `${label} ${difficulty[key]} of 3`).join(", ");
  return (
    <span
      className="difficulty"
      role="img"
      aria-label={`${suggested ? "Suggested difficulty" : "Difficulty"}: ${spoken}, total ${total} of 9`}
    >
      {METERS.map(([label, key]) => (
        <span key={key} className="meter">
          <span className="meter-label">{label}</span>
          <span className="pips">
            {[1, 2, 3].map((pip) => (
              <span key={pip} className={pip <= difficulty[key] ? "pip pip-on" : "pip"} />
            ))}
          </span>
        </span>
      ))}
      <span className="difficulty-total">
        Total {total}/9
        {suggested && <span className="difficulty-suggested">Suggested</span>}
      </span>
    </span>
  );
}
