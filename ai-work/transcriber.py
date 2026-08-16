import os
import tempfile
import mimetypes
from flask import Flask, request, jsonify
from flask_cors import CORS
from google import genai
from dotenv import load_dotenv

load_dotenv()

app = Flask(__name__)
CORS(app)

client = genai.Client()

PROMPT = """
Transcribe accurately. 
Remove filler words, stutters, background noise.
First summarize the main points of the audio in 1-2 sentences.
write above the title "Summary of the audio call" and then write the summary.
Then clean transcription full audio only.
write above the title "Clean Transcription of audio call" and then write the clean transcription.
No extra commentary, no extra text, no extra words, no extra sentences.
"""

@app.route('/api/transcribe', methods=['POST'])
def handle_transcription():
    if 'file' not in request.files:
        return jsonify({"error": "No audio file provided in request."}), 400

    file = request.files['file']

    if file.filename == '':
        return jsonify({"error": "Selected file is empty."}), 400

    filename = file.filename
    _, ext = os.path.splitext(filename)

    if not ext and file.content_type:
        guessed_ext = mimetypes.guess_extension(file.content_type)
        ext = guessed_ext if guessed_ext else ".mp3"

    with tempfile.NamedTemporaryFile(delete=False, suffix=ext) as temp_file:
        file.save(temp_file.name)
        temp_path = temp_file.name

    try:
        # Upload file directly (extension tells Gemini the MIME type)
        gemini_file = client.files.upload(file=temp_path)
        print("file are start to transcribing")
        response = client.models.generate_content(
            model='gemini-2.5-flash',
            contents=[gemini_file, PROMPT]
        )

        client.files.delete(name=gemini_file.name)
        print(response.text)
        return jsonify({
            "success": True,
            "transcription": response.text
        }), 200

    except Exception as e:
        return jsonify({
            "success": False,
            "error": f"Failed to transcribe audio: {str(e)}"
        }), 500

    finally:
        if os.path.exists(temp_path):
            os.remove(temp_path)


if __name__ == '__main__':
    app.run(debug=True)