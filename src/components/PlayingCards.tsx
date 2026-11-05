// Playing cards drawn as card faces (used by Poker, Blackjack and Card Sharp clues).
const RED = new Set(['♥', '♦']);

export default function PlayingCards({ cards }: { cards: string[] }) {
  return (
    <div className="pcards" aria-label={cards.join(', ')}>
      {cards.map((c, i) => {
        const suit = c.slice(-1); const rank = c.slice(0, -1);
        return (
          <span key={i} className="pcard" style={{ color: RED.has(suit) ? '#d8232f' : '#121722' }}>
            <small>{i + 1}</small>
            <b>{rank}</b><i>{suit}</i>
          </span>
        );
      })}
    </div>
  );
}
