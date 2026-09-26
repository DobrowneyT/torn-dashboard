// @vitest-environment jsdom
//
// #793 — the roll-call results table, sortable by every header.
//
// It was hard-sorted by name, so a lead scanning "who is turning up" had to
// read every row. These tests are about the ORDER meaning something.
import { describe, it, expect } from 'vitest'
import { render, screen, fireEvent, within } from '@testing-library/react'
import RollCallResultsTable from '../RollCallResultsTable'

const row = (name, over = {}) => ({
  member_id: name, member_name: name,
  on_at_start: false, availability: null,
  can_self_hospital: false, needs_merc: false, revised: false,
  ...over,
})

const ROWS = [
  row('Zed',   { availability: 'unavailable' }),
  row('Alice', { on_at_start: true, availability: 'on_time' }),
  row('Bob',   { availability: '6_plus' }),
  row('Cara',  { availability: '1_2h', can_self_hospital: true }),
  row('Dan',   { availability: null, needs_merc: true }),
]

const names = () =>
  screen.getAllByRole('row').slice(1).map(r => within(r).getAllByRole('cell')[0].textContent.trim())

const clickHeader = (label) => fireEvent.click(screen.getByLabelText(`Sort by ${label}`))

describe('RollCallResultsTable sorting', () => {
  it('defaults to name, as it always did', () => {
    render(<RollCallResultsTable rows={ROWS} />)
    expect(names()).toEqual(['Alice', 'Bob', 'Cara', 'Dan', 'Zed'])
  })

  it('reverses on a second click of the same header', () => {
    render(<RollCallResultsTable rows={ROWS} />)
    clickHeader('Member')
    expect(names()).toEqual(['Zed', 'Dan', 'Cara', 'Bob', 'Alice'])
  })

  it('⚠️ sorts Availability by how late, not alphabetically', () => {
    // Alphabetical gives "1–2 Hours Late, 3–5, 6+, On time, Will not be
    // available" — which buries the people turning up in the middle.
    render(<RollCallResultsTable rows={ROWS} />)
    clickHeader('Availability')
    expect(names()).toEqual(['Alice', 'Cara', 'Bob', 'Dan', 'Zed'])
  })

  it('puts the people who are turning up first when sorting by Start', () => {
    render(<RollCallResultsTable rows={ROWS} />)
    clickHeader('Start')
    expect(names()[0]).toBe('Alice')
  })

  it('groups Self-hosp so the column can actually be compared', () => {
    // ⚠️ "—" is rendered for everybody who IS on at the start; scattering them
    // through the middle would defeat the point of sorting this column.
    render(<RollCallResultsTable rows={ROWS} />)
    clickHeader('Self-hosp')
    const order = names()
    expect(order.indexOf('Cara')).toBeLessThan(order.indexOf('Dan'))   // can < merc
    expect(order.indexOf('Dan')).toBeLessThan(order.indexOf('Alice'))  // merc < n/a
  })

  it('⚠️ breaks ties by name in a fixed direction', () => {
    // Otherwise the order within a group depends on the order rows arrived in,
    // and the table reshuffles under a lead as responses come in.
    const tied = [row('Yan', { on_at_start: true }), row('Ann', { on_at_start: true })]
    render(<RollCallResultsTable rows={tied} />)
    clickHeader('Start')
    expect(names()).toEqual(['Ann', 'Yan'])
    clickHeader('Start')   // reversed primary, name still ascending within it
    expect(names()).toEqual(['Ann', 'Yan'])
  })

  it('keeps the tally and the edited highlight', () => {
    render(<RollCallResultsTable rows={[...ROWS, row('Eve', { on_at_start: true, revised: true })]} />)
    expect(screen.getByText('2 Yes')).toBeTruthy()
    expect(screen.getByText('4 No')).toBeTruthy()
    expect(screen.getByText('edited')).toBeTruthy()
  })

  it('still says so when nobody has responded', () => {
    render(<RollCallResultsTable rows={[]} />)
    expect(screen.getByText('No responses yet.')).toBeTruthy()
  })
})
