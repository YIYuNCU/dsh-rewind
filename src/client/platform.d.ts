declare module '@deepseek-ai/dsh-client-ui-primitives' {
  import type { ButtonHTMLAttributes, ComponentType, ReactNode } from 'react'

  export const Tooltip: ComponentType<{ label: string; side?: string; children: ReactNode }>
  export const Modal: ComponentType<{
    open: boolean
    onClose: () => void
    title: string
    closeLabel?: string
    description?: string
    children?: ReactNode
    footer?: ReactNode
  }>
  export const Button: ComponentType<{
    variant?: 'primary' | 'ghost' | 'outline' | 'toolbar'
    size?: 'md' | 'sm'
    icon?: ReactNode
  } & ButtonHTMLAttributes<HTMLButtonElement>>
  export const Switch: ComponentType<{
    checked: boolean
    onChange: (next: boolean) => void
    label: string
    disabled?: boolean
    title?: string
  }>
}
