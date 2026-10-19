import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { EmptyPlate, RANGE_MARK, RangeMark } from './texture'

describe('decorative texture', () => {
  it('hides the ascii mark and does not claim a live status', () => {
    const entered = renderToStaticMarkup(<RangeMark enter />)
    expect(entered).toContain('aria-hidden="true"')
    expect(entered).toContain('range-mark-enter')
    expect(entered).not.toContain('role="status"')
    expect(RANGE_MARK).toMatch(/ranger/)
    expect(RANGE_MARK).not.toMatch(/available|unavailable|connected|ready|failed|loading|progress|error/i)
    expect(renderToStaticMarkup(<EmptyPlate />)).toContain('dither-plate')
    expect(renderToStaticMarkup(<RangeMark />)).not.toContain('range-mark-enter')
  })
})
