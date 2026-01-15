<script setup lang="ts">
import { ref, computed, nextTick, onMounted, watch } from 'vue'
import { useChatStore } from '../stores/chat.store'
import { useSettingsStore } from '../stores/settings.store'
import { apiService } from '../services/api.service'
import { BaseButton } from '../components/common'
import { parseMediaFromMarkdown } from '../utils/markdown-parser'
import type { AppError } from '../services/api.service'

const chatStore = useChatStore()
const settingsStore = useSettingsStore()

// Refs
const messageInput = ref('')
const messagesContainer = ref<HTMLElement | null>(null)
const inputRef = ref<HTMLTextAreaElement | null>(null)

// Abort controller for streaming
let abortStream: (() => void) | null = null

// Computed
const isConfigured = computed(() => settingsStore.isConfigured)
const canSend = computed(() => 
  messageInput.value.trim().length > 0 && 
  !chatStore.isStreaming && 
  isConfigured.value
)

// Scroll to bottom
function scrollToBottom() {
  nextTick(() => {
    if (messagesContainer.value) {
      messagesContainer.value.scrollTop = messagesContainer.value.scrollHeight
    }
  })
}

// Watch for new messages and streaming content
watch(() => chatStore.messages.length, scrollToBottom)
watch(() => chatStore.currentStreamContent, scrollToBottom)

// Auto-resize textarea
function handleInputResize(event: Event) {
  const target = event.target as HTMLTextAreaElement
  target.style.height = 'auto'
  target.style.height = Math.min(target.scrollHeight, 150) + 'px'
}

// Send message
async function handleSend() {
  if (!canSend.value) return

  const content = messageInput.value.trim()
  messageInput.value = ''
  
  // Reset textarea height
  if (inputRef.value) {
    inputRef.value.style.height = 'auto'
  }

  // Add user message
  chatStore.addMessage({
    role: 'user',
    content
  })

  // Configure API service
  apiService.setConfig({
    baseUrl: settingsStore.apiBaseUrl,
    sessionId: settingsStore.sessionId,
    region: settingsStore.region
  })

  // Start streaming
  chatStore.startStreaming()

  // Prepare messages for API
  const messages = chatStore.messages.map(msg => ({
    role: msg.role,
    content: msg.content
  }))

  // Stream response
  abortStream = apiService.chatStream(
    messages,
    (chunk, done) => {
      if (done) {
        chatStore.finishStreaming()
        abortStream = null
      } else {
        chatStore.appendStreamContent(chunk)
      }
    },
    (error: AppError) => {
      chatStore.finishStreaming()
      chatStore.addMessage({
        role: 'assistant',
        content: `错误: ${error.message}`
      })
      abortStream = null
    }
  )
}

// Handle Enter key
function handleKeydown(event: KeyboardEvent) {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault()
    handleSend()
  }
}

// Stop streaming
function handleStop() {
  if (abortStream) {
    abortStream()
    chatStore.finishStreaming()
    abortStream = null
  }
}

// Clear chat
function handleClear() {
  chatStore.clearMessages()
}

// Parse media from content
function getMediaFromContent(content: string) {
  return parseMediaFromMarkdown(content)
}

// Format message content (remove markdown media syntax for display)
function formatContent(content: string): string {
  // Remove image and video markdown syntax
  return content
    .replace(/!\[video\]\([^)]+\)/gi, '')
    .replace(/!\[[^\]]*\]\([^)]+\)/g, '')
    .trim()
}

// Focus input on mount
onMounted(() => {
  inputRef.value?.focus()
})
</script>

<template>
  <div class="flex flex-col h-[calc(100vh-8rem)]">
    <!-- Header -->
    <div class="flex-shrink-0 px-6 py-4 border-b border-gray-200">
      <div class="flex items-center justify-between">
        <h1 class="text-xl font-bold text-gray-900">
          AI 对话
        </h1>
        <BaseButton
          v-if="chatStore.messages.length > 0"
          variant="outline"
          size="sm"
          @click="handleClear"
        >
          清空对话
        </BaseButton>
      </div>
    </div>

    <!-- Configuration Warning -->
    <div
      v-if="!isConfigured"
      class="flex-shrink-0 mx-6 mt-4 p-4 bg-yellow-50 border border-yellow-200 rounded-lg"
    >
      <p class="text-sm text-yellow-800">
        请先在设置中配置 Session ID
      </p>
    </div>

    <!-- Messages Container -->
    <div
      ref="messagesContainer"
      class="flex-1 overflow-y-auto px-6 py-4 space-y-4"
    >
      <!-- Empty State -->
      <div
        v-if="chatStore.messages.length === 0 && !chatStore.isStreaming"
        class="flex flex-col items-center justify-center h-full text-center"
      >
        <svg
          class="w-16 h-16 text-gray-300 mb-4"
          xmlns="http://www.w3.org/2000/svg"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
        >
          <path
            stroke-linecap="round"
            stroke-linejoin="round"
            stroke-width="1.5"
            d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"
          />
        </svg>
        <p class="text-gray-500 mb-2">开始与 AI 对话</p>
        <p class="text-sm text-gray-400">
          您可以让 AI 帮您生成图片或视频
        </p>
      </div>

      <!-- Messages -->
      <div
        v-for="message in chatStore.messages"
        :key="message.id"
        :class="[
          'flex',
          message.role === 'user' ? 'justify-end' : 'justify-start'
        ]"
      >
        <div
          :class="[
            'max-w-[80%] rounded-2xl px-4 py-3',
            message.role === 'user'
              ? 'bg-blue-600 text-white'
              : 'bg-gray-100 text-gray-900'
          ]"
        >
          <!-- Text Content -->
          <p class="whitespace-pre-wrap break-words">{{ formatContent(message.content) }}</p>
          
          <!-- Media Content -->
          <div v-if="getMediaFromContent(message.content).length > 0" class="mt-3 space-y-2">
            <template v-for="(media, index) in getMediaFromContent(message.content)" :key="index">
              <!-- Image -->
              <img
                v-if="media.type === 'image'"
                :src="media.url"
                :alt="media.alt || 'Generated image'"
                class="max-w-full rounded-lg cursor-pointer hover:opacity-90 transition-opacity"
              />
              <!-- Video -->
              <video
                v-else-if="media.type === 'video'"
                :src="media.url"
                controls
                class="max-w-full rounded-lg"
              />
            </template>
          </div>
          
          <!-- Timestamp -->
          <p
            :class="[
              'text-xs mt-1',
              message.role === 'user' ? 'text-blue-200' : 'text-gray-400'
            ]"
          >
            {{ new Date(message.timestamp).toLocaleTimeString() }}
          </p>
        </div>
      </div>

      <!-- Streaming Message -->
      <div v-if="chatStore.isStreaming" class="flex justify-start">
        <div class="max-w-[80%] rounded-2xl px-4 py-3 bg-gray-100">
          <p class="text-gray-900 whitespace-pre-wrap break-words">
            {{ chatStore.currentStreamContent }}
            <span class="inline-block w-2 h-4 bg-blue-500 animate-pulse ml-1" />
          </p>
        </div>
      </div>
    </div>

    <!-- Input Area -->
    <div class="flex-shrink-0 px-6 py-4 border-t border-gray-200">
      <div class="flex items-end gap-3">
        <div class="flex-1 relative">
          <textarea
            ref="inputRef"
            v-model="messageInput"
            :disabled="chatStore.isStreaming || !isConfigured"
            placeholder="输入消息... (Shift+Enter 换行)"
            rows="1"
            class="w-full px-4 py-3 pr-12 rounded-xl border border-gray-300 bg-white text-gray-900 placeholder-gray-400 resize-none focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent disabled:opacity-50 disabled:cursor-not-allowed"
            @input="handleInputResize"
            @keydown="handleKeydown"
          />
        </div>
        
        <BaseButton
          v-if="chatStore.isStreaming"
          variant="danger"
          @click="handleStop"
        >
          停止
        </BaseButton>
        <BaseButton
          v-else
          variant="primary"
          :disabled="!canSend"
          @click="handleSend"
        >
          发送
        </BaseButton>
      </div>
    </div>
  </div>
</template>
