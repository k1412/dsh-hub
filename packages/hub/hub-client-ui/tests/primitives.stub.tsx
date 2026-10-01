import { createElement, type ReactNode } from 'react'

export function Modal({ open, title, description, children, footer }: {
  open: boolean; title: string; description?: string; children?: ReactNode; footer?: ReactNode
}): ReactNode {
  return open ? createElement('div', { role: 'dialog', 'aria-label': title }, description, children, footer) : null
}

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
