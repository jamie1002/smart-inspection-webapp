// 方向箭頭 SVG
// - direction: near/far（前後雙箭頭）、up/down/left/right（單箭頭）
// - angle: 直接指定旋轉角度（度），用於合併後的斜向提示（往左後…）；優先於 direction
export default function DirectionArrow({ direction, angle, color = "#fff", size = 24 }) {
  if (typeof angle === "number") {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" style={{ transform: `rotate(${angle}deg)` }}>
        <path d="M12 2 L20 18 L12 14 L4 18 Z" fill={color} />
      </svg>
    );
  }

  if (direction === "near" || direction === "far") {
    const rotation = direction === "near" ? 0 : 180;
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" style={{ transform: `rotate(${rotation}deg)` }}>
        <path d="M12 3 L16 9 L12 7 L8 9 Z" fill={color} />
        <path d="M12 21 L16 15 L12 17 L8 15 Z" fill={color} />
      </svg>
    );
  }
  const rotationMap = { up: 0, right: 90, down: 180, left: 270 };
  const rotation = rotationMap[direction] ?? 0;
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" style={{ transform: `rotate(${rotation}deg)` }}>
      <path d="M12 2 L20 18 L12 14 L4 18 Z" fill={color} />
    </svg>
  );
}
