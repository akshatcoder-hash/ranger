export const RANGE_MARK = [
  '   /\\    /\\',
  '  /  \\  /  \\',
  ' /    \\/    \\',
  '/   ranger   \\',
].join('\n')

export function RangeMark({ enter = false }: { enter?: boolean }) {
  return <pre className={enter ? 'range-mark range-mark-enter' : 'range-mark'} aria-hidden="true">{RANGE_MARK}</pre>
}

export function EmptyPlate() {
  return <div className="empty-plate" aria-hidden="true"><span className="dither-plate" /><RangeMark /></div>
}
