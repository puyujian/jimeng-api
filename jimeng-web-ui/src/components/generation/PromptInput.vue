<script setup lang="ts">
import { computed, ref } from 'vue'

interface Props {
  modelValue?: string
  negativePrompt?: string
  placeholder?: string
  maxLength?: number
  label?: string
  showNegativePrompt?: boolean
  disabled?: boolean
}

const props = withDefaults(defineProps<Props>(), {
  modelValue: '',
  negativePrompt: '',
  placeholder: '请输入提示词描述您想要生成的内容...',
  maxLength: 2000,
  label: '提示词',
  showNegativePrompt: true,
  disabled: false
})

const emit = defineEmits<{
  'update:modelValue': [value: string]
  'update:negativePrompt': [value: string]
}>()

const showNegative = ref(false)

const characterCount = computed(() => props.modelValue.length)
const negativeCharacterCount = computed(() => props.negativePrompt.length)

const isOverLimit = computed(() => characterCount.value > props.maxLength)
const isNegativeOverLimit = computed(() => negativeCharacterCount.value > props.maxLength)

const handleInput = (event: Event) => {
  const target = event.target as HTMLTextAreaElement
  emit('update:modelValue', target.value)
}

const handleNegativeInput = (event: Event) => {
  const target = event.target as HTMLTextAreaElement
  emit('update:negativePrompt', target.value)
}

const toggleNegativePrompt = () => {
  showNegative.value = !showNegative.value
  if (!showNegative.value) {
    emit('update:negativePrompt', '')
  }
}
</script>

<template>
  <div class="w-full space-y-3">
    <!-- Main Prompt -->
    <div>
      <div class="flex items-center justify-between mb-1.5">
        <label class="text-sm font-medium text-gray-700">
          {{ label }}
        </label>
        <span
          :class="[
            'text-xs',
            isOverLimit ? 'text-red-500' : 'text-gray-400'
          ]"
        >
          {{ characterCount }} / {{ maxLength }}
        </span>
      </div>
      <textarea
        :value="modelValue"
        :placeholder="placeholder"
        :disabled="disabled"
        rows="4"
        :class="[
          'w-full rounded-lg border px-4 py-3 text-gray-900 placeholder-gray-400 transition-colors duration-200 focus:outline-none focus:ring-2 resize-none',
          isOverLimit
            ? 'border-red-500 focus:border-red-500 focus:ring-red-500'
            : 'border-gray-300 focus:border-blue-500 focus:ring-blue-500',
          disabled ? 'opacity-50 cursor-not-allowed bg-gray-100' : ''
        ]"
        @input="handleInput"
      />
    </div>

    <!-- Negative Prompt Toggle -->
    <div v-if="showNegativePrompt">
      <button
        type="button"
        :disabled="disabled"
        class="inline-flex items-center gap-2 text-sm text-gray-600 hover:text-gray-900 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        @click="toggleNegativePrompt"
      >
        <svg
          :class="[
            'w-4 h-4 transition-transform duration-200',
            showNegative ? 'rotate-90' : ''
          ]"
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 20 20"
          fill="currentColor"
        >
          <path
            fill-rule="evenodd"
            d="M7.293 14.707a1 1 0 010-1.414L10.586 10 7.293 6.707a1 1 0 011.414-1.414l4 4a1 1 0 010 1.414l-4 4a1 1 0 01-1.414 0z"
            clip-rule="evenodd"
          />
        </svg>
        <span>{{ showNegative ? '隐藏' : '添加' }}反向提示词</span>
      </button>

      <!-- Negative Prompt Input -->
      <Transition name="slide">
        <div v-if="showNegative" class="mt-3">
          <div class="flex items-center justify-between mb-1.5">
            <label class="text-sm font-medium text-gray-700">
              反向提示词
            </label>
            <span
              :class="[
                'text-xs',
                isNegativeOverLimit ? 'text-red-500' : 'text-gray-400'
              ]"
            >
              {{ negativeCharacterCount }} / {{ maxLength }}
            </span>
          </div>
          <textarea
            :value="negativePrompt"
            placeholder="输入不希望出现在生成结果中的内容..."
            :disabled="disabled"
            rows="2"
            :class="[
              'w-full rounded-lg border px-4 py-3 text-gray-900 placeholder-gray-400 transition-colors duration-200 focus:outline-none focus:ring-2 resize-none',
              isNegativeOverLimit
                ? 'border-red-500 focus:border-red-500 focus:ring-red-500'
                : 'border-gray-300 focus:border-blue-500 focus:ring-blue-500',
              disabled ? 'opacity-50 cursor-not-allowed bg-gray-100' : ''
            ]"
            @input="handleNegativeInput"
          />
          <p class="mt-1 text-xs text-gray-500">
            描述您不希望在生成结果中出现的元素
          </p>
        </div>
      </Transition>
    </div>
  </div>
</template>

<style scoped>
.slide-enter-active,
.slide-leave-active {
  transition: all 0.2s ease;
}

.slide-enter-from,
.slide-leave-to {
  opacity: 0;
  transform: translateY(-10px);
}
</style>
