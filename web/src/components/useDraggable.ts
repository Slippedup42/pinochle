import { useCallback, useRef } from 'react'

export function useDraggable() {
  const posRef = useRef({ x: 0, y: 0, startX: 0, startY: 0, el: null as HTMLElement | null })
  const dragging = useRef(false)

  const onMouseDown = useCallback((e: React.MouseEvent | React.TouchEvent) => {
    const el = (e.target as HTMLElement).closest('[data-draggable]') as HTMLElement | null
    if (!el) return
    const rect = el.getBoundingClientRect()
    const clientX = 'touches' in e ? e.touches[0].clientX : e.clientX
    const clientY = 'touches' in e ? e.touches[0].clientY : e.clientY
    posRef.current = { x: rect.left, y: rect.top, startX: clientX, startY: clientY, el }
    dragging.current = true
    el.style.cursor = 'grabbing'
    el.style.transition = 'none'
  }, [])

  const onMouseMove = useCallback((e: MouseEvent | TouchEvent) => {
    if (!dragging.current || !posRef.current.el) return
    const clientX = 'touches' in e ? e.touches[0].clientX : e.clientX
    const clientY = 'touches' in e ? e.touches[0].clientY : e.clientY
    const dx = clientX - posRef.current.startX
    const dy = clientY - posRef.current.startY
    posRef.current.el.style.transform = `translate(${posRef.current.x + dx}px, ${posRef.current.y + dy}px)`
    posRef.current.el.style.position = 'fixed'
    posRef.current.el.style.left = '0'
    posRef.current.el.style.top = '0'
    posRef.current.el.style.margin = '0'
  }, [])

  const onMouseUp = useCallback(() => {
    if (!dragging.current) return
    dragging.current = false
    if (posRef.current.el) {
      posRef.current.el.style.cursor = ''
      posRef.current.el.style.transition = ''
    }
  }, [])

  return { onMouseDown, onMouseMove, onMouseUp }
}
