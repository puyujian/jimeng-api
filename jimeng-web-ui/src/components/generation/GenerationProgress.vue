<script setup lang="ts">
import { computed, ref, onMounted, onUnmounted, watch } from 'vue'
import type { GenerationStatus } from '../../types'

interface Props {
  status: GenerationStatus
  progress?: number
  message?: string
  showPercentage?: boolean
  startTime?: number | null
  endTime?: number | null
}

const props = withDefaults(defineProps<Props>(), {
  status: 'idle',
  progress: 0,
  message: '',
  showPercentage: true,
  startTime: null,
  endTime: null,
})

// 实时计时器
const currentTime = ref(Date.now())
let timer: ReturnType<typeof setInterval> | null = null

onMounted(() => {
  if (props.status === 'loading') {
    startTimer()
  }
})

onUnmounted(() => {
  stopTimer()
})

watch(
  () => props.status,
  (newStatus) => {
    if (newStatus === 'loading') {
      startTimer()
    } else {
      stopTimer()
    }
  }
)

function startTimer() {
  if (timer) return
  timer = setInterval(() => {
    currentTime.value = Date.now()
  }, 1000)
}

function stopTimer() {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
}

// 计算耗时
const elapsedSeconds = computed(() => {
  if (!props.startTime) return null
  const end = props.endTime || currentTime.value
  return Math.floor((end - props.startTime) / 1000)
})

const formattedElapsedTime = computed(() => {
  if (elapsedSeconds.value === null) return ''
  const seconds = elapsedSeconds.value
  if (seconds < 60) return `${seconds}秒`
  const minutes = Math.floor(seconds / 60)
  const remainingSeconds = seconds % 60
  return `${minutes}分${remainingSeconds}秒`
})

const statusConfig = computed(() => {
  const configs = {
    idle: { icon: 'idle', color: 'gray', defaultMessage: '准备就绪' },
    loading: { icon: 'loading', color: 'blue', defaultMessage: '正在生成中...' },
    success: { icon: 'success', color: 'green', defaultMessage: '生成完成' },
    error: { icon: 'error', color: 'red', defaultMessage: '生成失败' },
  }
  return configs[props.status]
})

const displayMessage = computed(() => props.message || statusConfig.value.defaultMessage)

const progressWidth = computed(() => {
  if (props.status === 'loading' && props.progress > 0) {
    return `${Math.min(100, Math.max(0, props.progress))}%`
  }
  return '0%'
})

const colorClasses = computed(() => {
  const colors = {
    gray: { bg: 'bg-gray-100', text: 'text-gray-600', progress: 'bg-gray-400', icon: 'text-gray-400' },
    blue: { bg: 'bg-blue-50', text: 'text-blue-700', progress: 'bg-blue-500', icon: 'text-blue-500' },
    green: { bg: 'bg-green-50', text: 'text-green-700', progress: 'bg-green-500', icon: 'text-green-500' },
    red: { bg: 'bg-red-50', text: 'text-red-700', progress: 'bg-red-500', icon: 'text-red-500' },
  }
  return colors[statusConfig.value.color as keyof typeof colors]
})
</script>

<template>
  <div :class="['rounded-lg p-4 transition-colors duration-300', colorClasses.bg]">
    <div class="flex items-center gap-3">
      <!-- Status Icon -->
      <div :class="['flex-shrink-0', colorClasses.icon]">
        <svg v-if="statusConfig.icon === 'idle'" class="w-6 h-6" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
        <svg v-else-if="statusConfig.icon === 'loading'" class="w-6 h-6 animate-spin" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
          <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" />
          <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
        </svg>
        <svg v-else-if="statusConfig.icon === 'success'" class="w-6 h-6" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor">
          <path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clip-rule="evenodd" />
        </svg>
        <svg v-else-if="statusConfig.icon === 'error'" class="w-6 h-6" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor">
          <path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z" clip-rule="evenodd" />
        </svg>
      </div>

      <!-- Message and Progress -->
      <div class="flex-1 min-w-0">
        <div class="flex items-center justify-between gap-2">
          <p :class="['text-sm font-medium', colorClasses.text]">{{ displayMessage }}</p>
          <div class="flex items-center gap-2 flex-shrink-0">
            <span v-if="formattedElapsedTime" :class="['text-xs', colorClasses.text]">
              {{ status === 'loading' ? '已用时' : '耗时' }} {{ formattedElapsedTime }}
            </span>
            <span v-if="status === 'loading' && showPercentage && progress > 0" :class="['text-sm font-medium', colorClasses.text]">
              {{ Math.round(progress) }}%
            </span>
          </div>
        </div>

        <!-- Progress Bar -->
        <div v-if="status === 'loading'" class="mt-2 h-1.5 bg-gray-200 rounded-full overflow-hidden">
          <div v-if="progress > 0" :class="['h-full rounded-full transition-all duration-300', colorClasses.progress]" :style="{ width: progressWidth }" />
          <div v-else :class="['h-full rounded-full animate-indeterminate', colorClasses.progress]" />
        </div>
      </div>
    </div>

    <div v-if="$slots.default" class="mt-3 pl-9">
      <slot />
    </div>
  </div>
</template>

<style scoped>
@keyframes indeterminate {
  0% { transform: translateX(-100%); width: 50%; }
  50% { transform: translateX(0%); width: 50%; }
  100% { transform: translateX(200%); width: 50%; }
}
.animate-indeterminate {
  animation: indeterminate 1.5s ease-in-out infinite;
}
</style>
