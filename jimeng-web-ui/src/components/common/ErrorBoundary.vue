<script setup lang="ts">
import { ref, onErrorCaptured, provide } from 'vue'
import BaseButton from './BaseButton.vue'

interface Props {
  fallbackMessage?: string
  showRetry?: boolean
}

const props = withDefaults(defineProps<Props>(), {
  fallbackMessage: '出现了一些问题',
  showRetry: true
})

const emit = defineEmits<{
  error: [error: Error, info: string]
  retry: []
}>()

const error = ref<Error | null>(null)
const errorInfo = ref<string>('')

// Capture errors from child components
onErrorCaptured((err: Error, _instance, info: string) => {
  error.value = err
  errorInfo.value = info
  emit('error', err, info)
  
  // Return false to prevent error from propagating
  return false
})

// Retry handler
function handleRetry() {
  error.value = null
  errorInfo.value = ''
  emit('retry')
}

// Provide error state to children
provide('errorBoundary', {
  hasError: error,
  clearError: handleRetry
})
</script>

<template>
  <div v-if="error" class="error-boundary">
    <div class="flex flex-col items-center justify-center min-h-[200px] p-6 bg-red-50 rounded-lg border border-red-200">
      <!-- Error Icon -->
      <svg
        class="w-12 h-12 text-red-500 mb-4"
        xmlns="http://www.w3.org/2000/svg"
        fill="none"
        viewBox="0 0 24 24"
        stroke="currentColor"
      >
        <path
          stroke-linecap="round"
          stroke-linejoin="round"
          stroke-width="2"
          d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
        />
      </svg>
      
      <!-- Error Message -->
      <h3 class="text-lg font-semibold text-red-800 mb-2">
        {{ fallbackMessage }}
      </h3>
      
      <p class="text-sm text-red-600 mb-4 text-center max-w-md">
        {{ error.message || '发生了未知错误，请稍后重试' }}
      </p>
      
      <!-- Error Details (dev mode) -->
      <details
        v-if="errorInfo"
        class="w-full max-w-md mb-4 text-xs text-red-500"
      >
        <summary class="cursor-pointer hover:underline">查看详情</summary>
        <pre class="mt-2 p-2 bg-red-100 rounded overflow-auto max-h-32">{{ errorInfo }}</pre>
      </details>
      
      <!-- Retry Button -->
      <BaseButton
        v-if="showRetry"
        variant="danger"
        size="sm"
        @click="handleRetry"
      >
        重试
      </BaseButton>
    </div>
  </div>
  
  <slot v-else />
</template>
