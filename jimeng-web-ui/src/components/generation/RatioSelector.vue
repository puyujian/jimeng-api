<script setup lang="ts">
import { computed } from 'vue'
import { IMAGE_RATIOS, VIDEO_RATIOS, type RatioOption } from '../../config'

interface Props {
  modelValue?: string
  type?: 'image' | 'video'
  label?: string
  disabled?: boolean
  constraintDisabled?: boolean
  constraintMessage?: string
}

const props = withDefaults(defineProps<Props>(), {
  modelValue: '1:1',
  type: 'image',
  label: '比例',
  disabled: false,
  constraintDisabled: false,
  constraintMessage: ''
})

const emit = defineEmits<{
  'update:modelValue': [value: string]
}>()

const ratioOptions = computed<RatioOption[]>(() => {
  return props.type === 'video' ? VIDEO_RATIOS : IMAGE_RATIOS
})

const isDisabled = computed(() => props.disabled || props.constraintDisabled)

const getPreviewStyle = (ratio: RatioOption) => {
  const maxSize = 32
  const aspectRatio = ratio.width / ratio.height
  let width: number
  let height: number
  if (aspectRatio >= 1) {
    width = maxSize
    height = maxSize / aspectRatio
  } else {
    height = maxSize
    width = maxSize * aspectRatio
  }
  return { width: `${width}px`, height: `${height}px` }
}

const handleSelect = (value: string) => {
  if (!isDisabled.value) {
    emit('update:modelValue', value)
  }
}
</script>

<template>
  <div class="w-full">
    <label v-if="label" class="block mb-2 text-sm font-medium text-gray-700">
      {{ label }}
      <span v-if="constraintDisabled" class="text-yellow-600 ml-1">(已锁定)</span>
    </label>
    
    <div v-if="constraintDisabled && constraintMessage" class="mb-2 p-2 bg-yellow-50 border border-yellow-200 rounded-lg">
      <p class="text-xs text-yellow-800">{{ constraintMessage }}</p>
    </div>
    
    <div class="grid grid-cols-4 sm:grid-cols-8 gap-2">
      <button
        v-for="ratio in ratioOptions"
        :key="ratio.value"
        type="button"
        :disabled="isDisabled"
        :class="[
          'flex flex-col items-center justify-center p-2 rounded-lg border-2 transition-all duration-200',
          modelValue === ratio.value ? 'border-blue-500 bg-blue-50' : 'border-gray-200 hover:border-gray-300',
          isDisabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'
        ]"
        @click="handleSelect(ratio.value)"
      >
        <div class="flex items-center justify-center mb-1.5" style="height: 36px;">
          <div
            :style="getPreviewStyle(ratio)"
            :class="['rounded-sm border', modelValue === ratio.value ? 'bg-blue-200 border-blue-400' : 'bg-gray-200 border-gray-300']"
          />
        </div>
        <span :class="['text-xs font-medium', modelValue === ratio.value ? 'text-blue-700' : 'text-gray-600']">
          {{ ratio.label }}
        </span>
      </button>
    </div>
  </div>
</template>
