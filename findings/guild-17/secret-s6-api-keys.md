# Secret flow S6: third-party API keys (OpenAI/Anthropic/Perplexity/xAI, ADOPTION_SEARCH_TOKEN)
_head 6efe5fdbe_

## Injection (answer-engine-check)
  32:          OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
  33:          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
  34:          PERPLEXITY_API_KEY: ${{ secrets.PERPLEXITY_API_KEY }}
  35:          XAI_API_KEY: ${{ secrets.XAI_API_KEY }}
  36:          ROOM_OPS_POST_TOKEN: ${{ secrets.ROOM_OPS_POST_TOKEN }}
  37:          ROOM_OPS_ROOM_ID: ${{ secrets.ROOM_OPS_ROOM_ID }}
  38:          ANALYTICS_INGEST_TOKEN: ${{ secrets.ANALYTICS_INGEST_TOKEN }}

## Artifacts uploaded (raw answers, 90d retention)
  40:      - uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02 # v4
  41-        if: always()
  42-        with:
  43-          name: answer-engine-${{ steps.day.outputs.day }}
  44-          path: |

## Script: do raw answers echo request headers/keys?
  213:      "x-api-key": credential,
  218:  return { authorization: `Bearer ${credential}`, "content-type": "application/json" };

## snippet-adoption token
  4:# ADOPTION_SEARCH_TOKEN, when set, is a fine-grained PAT for public repositories
  6:# with "skipped: ADOPTION_SEARCH_TOKEN not set" if public code search is refused.
  33:          ADOPTION_SEARCH_TOKEN: ${{ secrets.ADOPTION_SEARCH_TOKEN }}
