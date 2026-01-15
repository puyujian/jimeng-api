import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import type { GenerationStatus } from '../types'
import { useCreditStore } from './credit.store'

const STORAGE_KEY = 'jimeng_generation_state_v2'

type TaskType = 'image' | 'composition' | 'video'

interface TaskState {
  status: GenerationStatus
  results: string[]
  error: string | null
  startTime: number | null
  endTime: number | null
}

interface StoredGenerationState {
  image: TaskState
  composition: TaskState
  video: TaskState
}

function createEmptyTaskState(): TaskState {
  return {
    status: 'idle',
    results: [],
    error: null,
    startTime: null,
    endTime: null,
  }
}

// 从 localStorage 加载初始状态
function loadInitialState(): StoredGenerationState {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (stored) {
      const state: StoredGenerationState = JSON.parse(stored)
      // 检查超时的任务
      const checkTimeout = (taskState: TaskState): TaskState => {
        if (taskState.status === 'loading' && taskState.startTime) {
          const elapsed = Date.now() - taskState.startTime
          if (elapsed > 15 * 60 * 1000) {
            return {
              ...taskState,
              status: 'error',
              error: '检测到页面刷新，任务已中断。请重新生成。',
              endTime: Date.now(),
            }
          }
        }
        return taskState
      }
      return {
        image: state.image ? checkTimeout(state.image) : createEmptyTaskState(),
        composition: state.composition ? checkTimeout(state.composition) : createEmptyTaskState(),
        video: state.video ? checkTimeout(state.video) : createEmptyTaskState(),
      }
    }
  } catch {
    // If parsing fails, use defaults
  }
  return {
    image: createEmptyTaskState(),
    composition: createEmptyTaskState(),
    video: createEmptyTaskState(),
  }
}

export const useGenerationStore = defineStore('generation', () => {
  // 初始化时从 localStorage 加载状态
  const initialState = loadInitialState()
  
  // 每种类型独立的状态
  const imageState = ref<TaskState>(initialState.image)
  const compositionState = ref<TaskState>(initialState.composition)
  const videoState = ref<TaskState>(initialState.video)

  // 获取指定类型的状态
  function getState(type: TaskType): TaskState {
    switch (type) {
      case 'image':
        return imageState.value
      case 'composition':
        return compositionState.value
      case 'video':
        return videoState.value
    }
  }

  // 获取指定类型的状态 ref
  function getStateRef(type: TaskType) {
    switch (type) {
      case 'image':
        return imageState
      case 'composition':
        return compositionState
      case 'video':
        return videoState
    }
  }

  // Computed - 为了兼容性保留，返回当前正在生成的任务状态
  const isGenerating = computed(() => 
    imageState.value.status === 'loading' ||
    compositionState.value.status === 'loading' ||
    videoState.value.status === 'loading'
  )

  // Actions
  function startGeneration(type: TaskType) {
    const stateRef = getStateRef(type)
    stateRef.value = {
      status: 'loading',
      results: [],
      error: null,
      startTime: Date.now(),
      endTime: null,
    }
    saveToStorage()
  }

  function setResults(type: TaskType, urls: string[]) {
    const stateRef = getStateRef(type)
    stateRef.value = {
      ...stateRef.value,
      results: urls,
      status: 'success',
      error: null,
      endTime: Date.now(),
    }
    saveToStorage()
    
    // 生成成功后刷新积分
    refreshCreditAfterGeneration()
  }

  function setError(type: TaskType, message: string) {
    const stateRef = getStateRef(type)
    stateRef.value = {
      ...stateRef.value,
      error: message,
      status: 'error',
      endTime: Date.now(),
    }
    saveToStorage()
  }

  // Check if error indicates session needs refresh
  function isSessionError(message: string): boolean {
    const sessionErrorKeywords = [
      '额度不够',
      '积分不足',
      'session',
      'sessionid',
      '认证',
      '登录',
      '过期',
      '无效',
      '401',
      '403',
      'unauthorized',
      'forbidden'
    ]
    
    return sessionErrorKeywords.some(keyword => 
      message.toLowerCase().includes(keyword.toLowerCase())
    )
  }

  // Get user-friendly error message with session guidance
  function getErrorWithGuidance(type: TaskType): string | null {
    const state = getState(type)
    if (!state.error) return null
    
    if (isSessionError(state.error)) {
      return `${state.error}\n\n💡 提示：请前往设置页面重新获取 Session ID`
    }
    
    return state.error
  }

  function resetType(type: TaskType) {
    const stateRef = getStateRef(type)
    stateRef.value = createEmptyTaskState()
    saveToStorage()
  }

  function reset() {
    imageState.value = createEmptyTaskState()
    compositionState.value = createEmptyTaskState()
    videoState.value = createEmptyTaskState()
    clearStorage()
  }

  function saveToStorage() {
    const state: StoredGenerationState = {
      image: sanitizeTaskState(imageState.value),
      composition: sanitizeTaskState(compositionState.value),
      video: sanitizeTaskState(videoState.value),
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
  }

  // 清理任务状态，不保存 loading 状态
  function sanitizeTaskState(taskState: TaskState): TaskState {
    // loading 状态不持久化，避免刷新后状态不一致
    if (taskState.status === 'loading') {
      return createEmptyTaskState()
    }
    return taskState
  }

  function loadFromStorage() {
    try {
      const stored = localStorage.getItem(STORAGE_KEY)
      if (stored) {
        const state: StoredGenerationState = JSON.parse(stored)
        
        if (state.image) imageState.value = state.image
        if (state.composition) compositionState.value = state.composition
        if (state.video) videoState.value = state.video

        // 检查超时的任务
        const checkTimeout = (stateRef: typeof imageState) => {
          if (stateRef.value.status === 'loading' && stateRef.value.startTime) {
            const elapsed = Date.now() - stateRef.value.startTime
            if (elapsed > 15 * 60 * 1000) {
              stateRef.value = {
                ...stateRef.value,
                status: 'error',
                error: '检测到页面刷新，任务已中断。请重新生成。',
                endTime: Date.now(),
              }
            }
          }
        }
        
        checkTimeout(imageState)
        checkTimeout(compositionState)
        checkTimeout(videoState)
        saveToStorage()
      }
    } catch {
      // If parsing fails, use defaults
    }
  }

  function clearStorage() {
    localStorage.removeItem(STORAGE_KEY)
  }

  // 生成完成后刷新积分
  function refreshCreditAfterGeneration() {
    try {
      const creditStore = useCreditStore()
      creditStore.fetchCredit()
    } catch (error) {
      console.error('Failed to refresh credit after generation:', error)
    }
  }

  return {
    // State refs for each type
    imageState,
    compositionState,
    videoState,
    // Helpers
    getState,
    // Computed
    isGenerating,
    // Actions
    startGeneration,
    setResults,
    setError,
    resetType,
    reset,
    loadFromStorage,
    saveToStorage,
    // Session error helpers
    isSessionError,
    getErrorWithGuidance,
  }
})
