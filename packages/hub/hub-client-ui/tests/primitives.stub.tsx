import { createElement, type ReactNode } from 'react'

interface MenuItem {
  id: string
  label: ReactNode
  disabled?: boolean
}

interface MenuProps {
  open: boolean
  items: MenuItem[]
  anchor: ReactNode
  onSelect: (id: string) => void
}

export function Menu({ open, items, anchor, onSelect }: MenuProps): ReactNode {
  return createElement('div', null,
    anchor,
    open
      ? createElement('div', { role: 'menu' }, items.map(item => createElement('button', {
          key: item.id,
          type: 'button',
          role: 'menuitem',
          disabled: item.disabled,
          onClick: () => { onSelect(item.id) },
        }, item.label)))
      : null,
  )
}

export function IconApiOutline14(props: Record<string, unknown>): ReactNode {
  return createElement('span', { ...props, 'aria-hidden': true })
}

export function IconChevronDownOutline14(props: Record<string, unknown>): ReactNode {
  return createElement('span', { ...props, 'aria-hidden': true })
}
