// A recipe's Tags as chips, in stored order. With a limit, the Tags past it fold into one "+N"
// chip. Nothing shows for a recipe without Tags.
export function TagList({ tags, limit = Infinity }: { tags: string[]; limit?: number }) {
  if (tags.length === 0) return null;
  const more = tags.length - limit;
  return (
    <ul className="tags" aria-label="Tags">
      {tags.slice(0, limit).map((tag) => (
        <li key={tag} className="tag">
          {tag}
        </li>
      ))}
      {more > 0 && (
        <li className="tag tag-more">
          +{more}
          <span className="visually-hidden"> more tags</span>
        </li>
      )}
    </ul>
  );
}
