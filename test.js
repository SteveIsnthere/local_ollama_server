import ollama from 'ollama'

ollama.list().then(list => console.log(list));