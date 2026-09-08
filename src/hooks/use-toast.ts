// src/hooks/use-toast.ts
'use client'

import { useState, useCallback, useEffect } from 'react'

export type ToastVariant = 'default' | 'destructive' | 'success'

export interface Toast {
  id: string
  title?: string
  description?: string
  variant?: ToastVariant
}

let toastListeners: Array<(toasts: Toast[]) => void> = []
let toasts: Toast[] = []

function notify() {
  toastListeners.forEach((l) => l([...toasts]))
}

export function addToast(toast: Omit<Toast, 'id'>) {
  const id = Math.random().toString(36).slice(2)
  toasts = [...toasts, { ...toast, id }]
  notify()
  setTimeout(() => {
    toasts = toasts.filter((t) => t.id !== id)
    notify()
  }, 4000)
}

export function useToast() {
  const [, setUpdate] = useState(0)

  const toast = useCallback((t: Omit<Toast, 'id'>) => {
    addToast(t)
    setUpdate((n) => n + 1)
  }, [])

  return { toast }
}

export function useToastState() {
  const [currentToasts, setCurrentToasts] = useState<Toast[]>([])

  useEffect(() => {
    toastListeners.push(setCurrentToasts)
    return () => {
      toastListeners = toastListeners.filter((l) => l !== setCurrentToasts)
    }
  }, [])

  return currentToasts
}
