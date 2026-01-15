<script setup lang="ts">
import { computed } from 'vue'

interface Props {
  modelValue?: string
  type?: 'text' | 'textarea' | 'password' | 'email' | 'number' | 'url'
  placeholder?: string
  label?: string
  error?: string
  disabled?: boolean
  readonly?: boolean
  rows?: number
  maxlength?: number
}

const props = withDefaults(defineProps<Props>(), {
  modelValue: '',
  type: 'text',
  placeholder: '',
  label: '',
  error: '',
  disabled: false,
  readonly: false,
  rows: 3
})

const emit = defineEmits<{
  'update:modelValue': [value: string]
  blur: [event: FocusEvent]
  focus: [event: FocusEvent]
}>()

const inputClasses = computed(() => {
  const base = 'w-full rounded-lg border px-4 py-2 text-gray-900 placeholder-gray-400 transition-colors duration-200 focus:outline-none focus:ring-2'
  
  if (props.error) {
    return `${base} border-red-500 focus:border-red-500 focus:ring-red-500`
  }
  
  if (props.disabled) {
    return `${base} border-gray-200 bg-gray-100 cursor-not-allowed`
  }
  
  return `${base} border-gray-300 focus:border-blue-500 focus:ring-blue-500`
})

const handleInput = (event: Event) => {
  const target = event.target as HTMLInputElement | HTMLTextAreaElement
  emit('update:modelValue', target.value)
}
</script>

<template>
  <div class="w-full">
    <label v-if="label" class="block mb-1.5 text-sm font-medium text-gray-700">
      {{ label }}
    </label>
    
    <textarea
      v-if="type === 'textarea'"
      :value="modelValue"
      :placeholder="placeholder"
      :disabled="disabled"
      :readonly="readonly"
      :rows="rows"
      :maxlength="maxlength"
      :class="inputClasses"
      @input="handleInput"
      @blur="emit('blur', $event)"
      @focus="emit('focus', $event)"
    />
    
    <input
      v-else
      :type="type"
      :value="modelValue"
      :placeholder="placeholder"
      :disabled="disabled"
      :readonly="readonly"
      :maxlength="maxlength"
      :class="inputClasses"
      @input="handleInput"
      @blur="emit('blur', $event)"
      @focus="emit('focus', $event)"
    />
    
    <p v-if="error" class="mt-1.5 text-sm text-red-500">
      {{ error }}
    </p>
  </div>
</template>
