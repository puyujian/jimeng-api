import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { HistoryItem } from '../types'

const STORAGE_KEY = 'jimeng_history'
const STORAGE_VERSION = 1

interface StoredHistory {
  version: number
  items: HistoryItem[]
}

// 从 localStorage 加载初始状态
function loadInitialItems(): HistoryItem[] {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (stored) {
      const parsed: StoredHistory = JSON.parse(stored)
      if (parsed.version === STORAGE_VERSION) {
        return parsed.items || []
      }
    }
  } catch {
    // If parsing fails, use empty array
  }
  return []
}

export const useHistoryStore = defineStore('history', () => {
  // State - 初始化时从 localStorage 加载
  const items = ref<HistoryItem[]>(loadInitialItems())
  const selectedItem = ref<HistoryItem | null>(null)

  // Actions
  function addItem(item: Omit<HistoryItem, 'id' | 'createdAt'>) {
    const newItem: HistoryItem = {
      ...item,
      id: generateId(),
      createdAt: Date.now(),
    }
    items.value.unshift(newItem)
    saveToStorage()
  }

  function removeItem(id: string) {
    const index = items.value.findIndex((item) => item.id === id)
    if (index !== -1) {
      items.value.splice(index, 1)
      if (selectedItem.value?.id === id) {
        selectedItem.value = null
      }
      saveToStorage()
    }
  }

  function selectItem(id: string | null) {
    if (id === null) {
      selectedItem.value = null
    } else {
      selectedItem.value = items.value.find((item) => item.id === id) || null
    }
  }

  function loadFromStorage() {
    try {
      const stored = localStorage.getItem(STORAGE_KEY)
      if (stored) {
        const parsed: StoredHistory = JSON.parse(stored)
        if (parsed.version === STORAGE_VERSION) {
          items.value = parsed.items || []
        }
      }
    } catch {
      // If parsing fails, use empty array
      items.value = []
    }
  }

  function saveToStorage() {
    const data: StoredHistory = {
      version: STORAGE_VERSION,
      items: items.value,
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data))
  }

  function clearAll() {
    items.value = []
    selectedItem.value = null
    localStorage.removeItem(STORAGE_KEY)
  }

  // Helper function to generate unique IDs
  function generateId(): string {
    return `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`
  }

  return {
    // State
    items,
    selectedItem,
    // Actions
    addItem,
    removeItem,
    selectItem,
    loadFromStorage,
    saveToStorage,
    clearAll,
  }
})
