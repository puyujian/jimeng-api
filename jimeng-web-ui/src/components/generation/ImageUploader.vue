<script setup lang="ts">
import { ref, computed } from 'vue'

interface UploadedImage {
  id: string
  file?: File
  url: string
  name: string
  isUrl: boolean
}

interface Props {
  modelValue?: UploadedImage[]
  maxFiles?: number
  maxSize?: number // in MB
  accept?: string
  label?: string
  disabled?: boolean
  showUrlInput?: boolean
}

const props = withDefaults(defineProps<Props>(), {
  modelValue: () => [],
  maxFiles: 5,
  maxSize: 10,
  accept: 'image/*',
  label: '上传图片',
  disabled: false,
  showUrlInput: true
})

const emit = defineEmits<{
  'update:modelValue': [value: UploadedImage[]]
}>()

const isDragging = ref(false)
const urlInput = ref('')
const showUrlForm = ref(false)
const error = ref('')

const canAddMore = computed(() => props.modelValue.length < props.maxFiles)

const generateId = () => Math.random().toString(36).substring(2, 11)

const validateFile = (file: File): string | null => {
  if (!file.type.startsWith('image/')) {
    return '只支持图片文件'
  }
  if (file.size > props.maxSize * 1024 * 1024) {
    return `文件大小不能超过 ${props.maxSize}MB`
  }
  return null
}

const handleFiles = (files: FileList | File[]) => {
  error.value = ''
  const fileArray = Array.from(files)
  const remainingSlots = props.maxFiles - props.modelValue.length
  
  if (fileArray.length > remainingSlots) {
    error.value = `最多只能上传 ${props.maxFiles} 张图片`
    return
  }
  
  const newImages: UploadedImage[] = []
  
  for (const file of fileArray) {
    const validationError = validateFile(file)
    if (validationError) {
      error.value = validationError
      continue
    }
    
    newImages.push({
      id: generateId(),
      file,
      url: URL.createObjectURL(file),
      name: file.name,
      isUrl: false
    })
  }
  
  if (newImages.length > 0) {
    emit('update:modelValue', [...props.modelValue, ...newImages])
  }
}

const handleDrop = (event: DragEvent) => {
  isDragging.value = false
  if (props.disabled || !canAddMore.value) return
  
  const files = event.dataTransfer?.files
  if (files && files.length > 0) {
    handleFiles(files)
  }
}

const handleDragOver = (event: DragEvent) => {
  event.preventDefault()
  if (!props.disabled && canAddMore.value) {
    isDragging.value = true
  }
}

const handleDragLeave = () => {
  isDragging.value = false
}

const handleFileInput = (event: Event) => {
  const target = event.target as HTMLInputElement
  if (target.files && target.files.length > 0) {
    handleFiles(target.files)
    target.value = '' // Reset input
  }
}

const addUrlImage = () => {
  error.value = ''
  const url = urlInput.value.trim()
  
  if (!url) {
    error.value = '请输入图片URL'
    return
  }
  
  // Basic URL validation
  try {
    new URL(url)
  } catch {
    error.value = '请输入有效的URL'
    return
  }
  
  if (!canAddMore.value) {
    error.value = `最多只能上传 ${props.maxFiles} 张图片`
    return
  }
  
  const newImage: UploadedImage = {
    id: generateId(),
    url,
    name: url.split('/').pop() || 'image',
    isUrl: true
  }
  
  emit('update:modelValue', [...props.modelValue, newImage])
  urlInput.value = ''
  showUrlForm.value = false
}

const removeImage = (id: string) => {
  const image = props.modelValue.find(img => img.id === id)
  if (image && !image.isUrl && image.url.startsWith('blob:')) {
    URL.revokeObjectURL(image.url)
  }
  emit('update:modelValue', props.modelValue.filter(img => img.id !== id))
}

const triggerFileInput = () => {
  const input = document.createElement('input')
  input.type = 'file'
  input.accept = props.accept
  input.multiple = props.maxFiles > 1
  input.onchange = (e) => handleFileInput(e)
  input.click()
}
</script>

<template>
  <div class="w-full">
    <label v-if="label" class="block mb-2 text-sm font-medium text-gray-700">
      {{ label }}
      <span class="text-gray-400 font-normal">({{ modelValue.length }}/{{ maxFiles }})</span>
    </label>

    <!-- Upload Area -->
    <div
      v-if="canAddMore"
      :class="[
        'relative border-2 border-dashed rounded-lg p-6 transition-all duration-200',
        isDragging
          ? 'border-blue-500 bg-blue-50'
          : 'border-gray-300',
        disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer hover:border-gray-400'
      ]"
      @drop.prevent="handleDrop"
      @dragover="handleDragOver"
      @dragleave="handleDragLeave"
      @click="!disabled && triggerFileInput()"
    >
      <div class="flex flex-col items-center justify-center text-center">
        <svg
          class="w-10 h-10 mb-3 text-gray-400"
          xmlns="http://www.w3.org/2000/svg"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
        >
          <path
            stroke-linecap="round"
            stroke-linejoin="round"
            stroke-width="2"
            d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"
          />
        </svg>
        <p class="text-sm text-gray-600">
          <span class="font-medium text-blue-600">点击上传</span>
          或拖拽图片到此处
        </p>
        <p class="mt-1 text-xs text-gray-500">
          支持 PNG, JPG, WEBP (最大 {{ maxSize }}MB)
        </p>
      </div>
    </div>

    <!-- URL Input Toggle -->
    <div v-if="showUrlInput && canAddMore" class="mt-3">
      <button
        v-if="!showUrlForm"
        type="button"
        :disabled="disabled"
        class="text-sm text-blue-600 hover:text-blue-700 disabled:opacity-50"
        @click="showUrlForm = true"
      >
        + 通过URL添加图片
      </button>
      
      <div v-else class="flex gap-2">
        <input
          v-model="urlInput"
          type="url"
          placeholder="输入图片URL..."
          :disabled="disabled"
          class="flex-1 px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
          @keyup.enter="addUrlImage"
        />
        <button
          type="button"
          :disabled="disabled"
          class="px-3 py-2 text-sm font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700 disabled:opacity-50"
          @click="addUrlImage"
        >
          添加
        </button>
        <button
          type="button"
          class="px-3 py-2 text-sm text-gray-600 hover:text-gray-800"
          @click="showUrlForm = false; urlInput = ''"
        >
          取消
        </button>
      </div>
    </div>

    <!-- Error Message -->
    <p v-if="error" class="mt-2 text-sm text-red-500">
      {{ error }}
    </p>

    <!-- Preview Grid -->
    <div v-if="modelValue.length > 0" class="mt-4 grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
      <div
        v-for="image in modelValue"
        :key="image.id"
        class="relative group aspect-square rounded-lg overflow-hidden bg-gray-100"
      >
        <img
          :src="image.url"
          :alt="image.name"
          class="w-full h-full object-cover"
          @error="(e) => (e.target as HTMLImageElement).src = 'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 24 24%22 fill=%22%239ca3af%22%3E%3Cpath d=%22M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z%22/%3E%3C/svg%3E'"
        />
        
        <!-- Overlay -->
        <div class="absolute inset-0 bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
          <button
            type="button"
            class="p-2 bg-red-500 text-white rounded-full hover:bg-red-600 transition-colors"
            @click.stop="removeImage(image.id)"
          >
            <svg class="w-4 h-4" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor">
              <path fill-rule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clip-rule="evenodd" />
            </svg>
          </button>
        </div>
        
        <!-- URL Badge -->
        <div
          v-if="image.isUrl"
          class="absolute top-1 left-1 px-1.5 py-0.5 text-xs bg-blue-500 text-white rounded"
        >
          URL
        </div>
      </div>
    </div>
  </div>
</template>
