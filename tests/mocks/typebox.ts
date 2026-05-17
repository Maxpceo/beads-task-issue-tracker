function schema(type: string, options: Record<string, unknown> = {}) {
  return { type, ...options }
}

export const Type = {
  Object: (properties: Record<string, unknown>, options: Record<string, unknown> = {}) => ({ type: 'object', properties, ...options }),
  String: (options: Record<string, unknown> = {}) => schema('string', options),
  Number: (options: Record<string, unknown> = {}) => schema('number', options),
  Integer: (options: Record<string, unknown> = {}) => schema('integer', options),
  Boolean: (options: Record<string, unknown> = {}) => schema('boolean', options),
  Array: (items: unknown, options: Record<string, unknown> = {}) => ({ type: 'array', items, ...options }),
  Optional: (value: unknown) => value,
  Union: (anyOf: unknown[], options: Record<string, unknown> = {}) => ({ anyOf, ...options }),
  Literal: (value: unknown) => ({ const: value }),
}
