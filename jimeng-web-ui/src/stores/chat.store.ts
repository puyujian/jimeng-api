import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { ChatMessage } from '../types'

export const useChatStore = defineStore('chat', () => {
  // State
  const messages = ref<ChatMessage[]>([])
  const isStreaming = ref(false)
  const currentStreamContent = ref('')

  // Actions
  function addMessage(message: Omit<ChatMessage, 'id' | 'timestamp'>) {
    const newMessage: ChatMessage = {
      ...message,
      id: generateId(),
      timestamp: Date.now(),
    }
    messages.value.push(newMessage)
    return newMessage.id
  }

  function updateStreamContent(content: string) {
    currentStreamContent.value = content
  }

  function appendStreamContent(chunk: string) {
    currentStreamContent.value += chunk
  }

  function startStreaming() {
    isStreaming.value = true
    currentStreamContent.value = ''
  }

  function finishStreaming() {
    if (currentStreamContent.value) {
      addMessage({
        role: 'assistant',
        content: currentStreamContent.value,
      })
    }
    isStreaming.value = false
    currentStreamContent.value = ''
  }

  function clearMessages() {
    messages.value = []
    isStreaming.value = false
    currentStreamContent.value = ''
  }

  // Helper function to generate unique IDs
  function generateId(): string {
    return `msg-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`
  }

  return {
    // State
    messages,
    isStreaming,
    currentStreamContent,
    // Actions
    addMessage,
    updateStreamContent,
    appendStreamContent,
    startStreaming,
    finishStreaming,
    clearMessages,
  }
})
