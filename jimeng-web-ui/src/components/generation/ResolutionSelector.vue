<script setup lang="ts">
import { computed } from 'vue'
import { IMAGE_RESOLUTIONS, VIDEO_RESOLUTIONS, type ResolutionOption } from '../../config'

interface Props {
  modelValue?: string
  type?: 'image' | 'video'
  label?: string
  disabled?: boolean
  forcedResolution?: string
}

const props = withDefaults(defineProps<Props>(), {
  modelValue: '2k',
  type: 'image',
  label: '分辨率',
  disabled: false,
  forcedResolution: ''
})

const emit = defineEmits<{
  'update:modelValue': [value: string]
}>()

const resolutionOptions = computed<ResolutionOption[]>(() => {
  return props.type === 'video' ? VIDEO_RESOLUTIONS : IMAGE_RESOLUTIONS
})

const isDisabled = computed(() => props.disabled || !!props.forcedResolution)
const displayValue = computed(() => props.forcedResolution || props.modelValue)

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
      <span v-if="forcedResolution" class="text-yellow-600 ml-1">(已锁定为 {{ forcedResolution.toUpperCase() }})</span>
    </label>
    
    <div class="grid grid-cols-3 gap-2">
      <button
        v-for="resolution in resolutionOptions"
        :key="resolution.value"
        type="button"
        :disabled="isDisabled"
        :class="[
          'flex flex-col items-center p-3 rounded-lg border-2 transition-all duration-200',
          displayValue === resolution.value ? 'border-blue-500 bg-blue-50' : 'border-gray-200 hover:border-gray-300',
          isDisabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'
        ]"
        @click="handleSelect(resolution.value)"
      >
        <span :class="['text-lg font-bold', displayValue === resolution.value ? 'text-blue-700' : 'text-gray-900']">
          {{ resolution.label }}
        </span>
        <span :class="['text-xs mt-0.5', displayValue === resolution.value ? 'text-blue-600' : 'text-gray-500']">
          {{ resolution.description }}
        </span>
        <span class="text-xs text-gray-400 mt-1">{{ resolution.pixels }}</span>
      </button>
    </div>
  </div>
</template>
