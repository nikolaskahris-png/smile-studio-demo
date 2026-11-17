# Smile Studio — AI receptionist (live demo)

**Live demo:** https://nikolaskahris-png.github.io/smile-studio-demo/

An AI receptionist chatbot for a **fictional** dental clinic. It shows what a small business gets:

- Answers from the business's own information (prices, hours, policies) — no made-up answers
- Checks real availability and books appointments into Google Sheets, without double-booking
- Saves leads for people who aren't ready to book
- Hands the conversation to a human when asked or when it doesn't know
- Replies in the customer's language (English, Greek, …)

**Stack:** static page (GitHub Pages) → Cloudflare Worker (keeps the API key private) → LLM with tool calling (Gemini; swappable for OpenAI or Claude) → Google Sheets via Apps Script.

The same bot can run on a website, WhatsApp or Telegram.

Built by Nikolas Kahris — AI chatbots & automations for small businesses.
