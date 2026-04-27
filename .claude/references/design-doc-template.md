# Design Doc Template

When the architect creates a design doc, it should include:

```markdown
# Feature: {name}

## Schema
```sql
-- Exact column names and types
ALTER TABLE x ADD COLUMN y TYPE;
```

## API Contract

```
POST /api/endpoint
Request: { field: type }
Response: { field: type }
```

## Shared Constants

```
STATUS_ACTIVE = 1
STATUS_INACTIVE = 0
```

## Data Flow

1. Frontend calls POST /api/...
2. Backend validates and stores in DB
3. Backend returns response

```
