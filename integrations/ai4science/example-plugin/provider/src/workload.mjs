/** CUSTOMIZE HERE: domain input validation and pure business work; no Agent or platform imports. */
export const inputSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['values', 'scale', 'offset'],
  properties: {
    values: {
      type: 'array',
      minItems: 1,
      maxItems: 10000,
      items: { type: 'number', minimum: -1e12, maximum: 1e12 },
    },
    scale: { type: 'number', minimum: -1e6, maximum: 1e6 },
    offset: { type: 'number', minimum: -1e12, maximum: 1e12 },
  },
}

export function validateInput(input) {
  if (
    !input ||
    typeof input !== 'object' ||
    Array.isArray(input) ||
    Object.keys(input).sort().join() !== 'offset,scale,values' ||
    !Array.isArray(input.values) ||
    input.values.length < 1 ||
    input.values.length > 10000 ||
    !Array.from(input.values).every(
      (v) => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= 1e12,
    ) ||
    typeof input.scale !== 'number' ||
    !Number.isFinite(input.scale) ||
    Math.abs(input.scale) > 1e6 ||
    typeof input.offset !== 'number' ||
    !Number.isFinite(input.offset) ||
    Math.abs(input.offset) > 1e12
  )
    throw new Error('Expected 1..10000 finite values, scale and offset within the declared bounds')
  return { values: [...input.values], scale: input.scale, offset: input.offset }
}

export function transform(input) {
  const values = input.values.map((value) => value * input.scale + input.offset)
  const sum = values.reduce((a, b) => a + b, 0)
  return {
    values,
    summary: {
      count: values.length,
      min: Math.min(...values),
      max: Math.max(...values),
      mean: sum / values.length,
    },
  }
}
